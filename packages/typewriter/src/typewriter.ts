import {
  type Cause,
  Data,
  Deferred,
  Duration,
  Effect,
  Predicate,
  Queue,
  Result,
  Schedule,
  Schema,
  Scope,
  Semaphore,
  Stream,
} from "effect";
import { Hash, Hex } from "ox";
import {
  createStorageView,
  type StorageLayout,
  type StorageView,
} from "storage-layout";
import {
  createEVM,
  type EVM,
  type EvmError,
  type ExecuteResult,
} from "typewriter-evm";
import {
  type Abi,
  decodeErrorResult,
  decodeEventLog,
  formatTransactionReceipt,
  getAbiItem,
  parseTransaction,
  toEventSelector,
} from "viem";
import type {
  MutationsConfig,
  SequencingConfig,
  StorageConfig,
  TypewriterApp,
  TypewriterManifest,
} from "./config";
import { Database, type Db, type DbError, type DbTransaction } from "./db";
import {
  deploymentLockKey,
  dropSchema,
  type MigrationError,
  migrate,
} from "./db-migrate";
import {
  deleteExecutionsFrom,
  insertKeccakPreimages,
  insertMutations,
  insertStorageSlots,
  selectKeccakPreimages,
  selectStorageSlots,
  updateMutationInclusion,
} from "./db-query";
import type { TypewriterMutationSchema } from "./db-schema";
import {
  encodeBatchArg,
  encodeEnqueueCalldata,
  encodeExecuteCalldata,
} from "./encoding";
import { durationMs, startTimer } from "./logger";
import { executeInputSchema } from "./mutation-schema";
import { Rpc, type RpcError } from "./rpc";
import {
  type BlockNotFoundError,
  type NoDataReturnedError,
  type RequestedBlock,
  requestBlock,
  requestExecutionIndex,
} from "./rpc-request";
import { EXPIRATION_MARGIN, TYPEWRITER_ABI } from "./typewriter-constants";
import type {
  AcceptedMutation,
  Authorization,
  BatchEvent,
  BatchListener,
  BlockEvent,
  BlockListener,
  IncludedMutation,
  Inclusion,
  MutationEvent,
  MutationListener,
  On,
  ReceivedMutation,
  RejectedMutation,
  RuntimeBatch,
  RuntimeBlock,
  RuntimeMutation,
  TypewriterMutationInput,
  TypewriterMutationResult,
} from "./typewriter-types";
import {
  type IncompleteBlockError,
  type LocalLog,
  makeWatch,
  type WatchError,
} from "./watch";

export type StorageRootProperty<
  storageConfig extends StorageConfig,
  name extends "accounts" | "state",
> =
  StorageView<storageConfig, false> extends infer root
    ? name extends keyof root
      ? root[name]
      : never
    : never;

export type TypewriterEffect<
  storageConfig extends StorageConfig = StorageConfig,
  mutationsConfig extends MutationsConfig = MutationsConfig,
  sequencingConfig extends SequencingConfig = SequencingConfig,
> = {
  state: StorageRootProperty<storageConfig, "state">;
  accounts: StorageRootProperty<storageConfig, "accounts">;
  schema: TypewriterMutationSchema<mutationsConfig>;
  manifest: TypewriterManifest<mutationsConfig>;
  execute: <const name extends keyof mutationsConfig & string>(
    submitted: TypewriterMutationInput<mutationsConfig, name>,
  ) => Effect.Effect<TypewriterMutationResult, ExecuteError>;
  on: On<sequencingConfig, mutationsConfig, Effect.Effect<() => void>>;
  /**
   * Accepts, submits and watches for blocks. It fails when the typewriter
   * can't continue, for example when it loses the deployment lock. Run it for
   * as long as the typewriter is in use.
   */
  program: Effect.Effect<never, ProgramError>;
};

// TODO(kyle) choose a timeout. It bounds how long startup waits for another
// process to release the deployment.
const DEPLOYMENT_LOCK_TIMEOUT_MS = 10_000;

const SUBMIT_RETRY_TIMES = 5;

type RuntimeExecuteInput = {
  name: string;
  params: unknown;
  authorization: Authorization;
};

/**
 * Resolves once a mutation executes. Its batch commits later, at `committed`.
 */
type AcceptDeferred = Deferred.Deferred<
  { mutation: AcceptedMutation; committed: Deferred.Deferred<void> },
  ExecuteMutationError
>;

/** A mutation that executed against the speculative state, and what it wrote. */
type AcceptedExecution<mutation extends AcceptedMutation = AcceptedMutation> = {
  mutation: mutation;
  executeResult: ExecuteResult;
  /** Preimages first seen in this mutation, to persist. */
  preimages: readonly Hex.Hex[];
};

/** `execute` got a mutation name that the app does not define. */
export class UnknownMutationError extends Data.TaggedError(
  "UnknownMutationError",
)<{
  mutation: string;
}> {
  override get message() {
    return `Unknown mutation '${this.mutation}'`;
  }
}

export class SignTransactionError extends Data.TaggedError(
  "SignTransactionError",
)<{
  cause: unknown;
}> {
  override get message() {
    return "Failed to sign settlement transaction";
  }
}

/** Each part of the program runs forever, so it stops only on a bug. */
export class ProgramStoppedError extends Data.TaggedError(
  "ProgramStoppedError",
) {
  override get message() {
    return "Typewriter program stopped unexpectedly";
  }
}

/** A settlement transaction reverted when simulated in revm. */
export class SettlementSimulationRevertedError extends Data.TaggedError(
  "SettlementSimulationRevertedError",
)<Revert> {
  override get message() {
    return revertMessage("Settlement transaction reverted in revm", this);
  }
}

/** A settlement transaction halted when simulated in revm. */
export class SettlementSimulationHaltedError extends Data.TaggedError(
  "SettlementSimulationHaltedError",
)<{
  reason: string;
}> {
  override get message() {
    return `Settlement transaction halted in revm with ${this.reason}`;
  }
}

/** A mutation that was enqueued onchain reverted when enqueued in revm. */
export class EnqueueRevertedError extends Data.TaggedError(
  "EnqueueRevertedError",
)<Revert> {
  override get message() {
    return revertMessage("Enqueued mutation reverted", this);
  }
}

/** A mutation that was enqueued onchain halted when enqueued in revm. */
export class EnqueueHaltedError extends Data.TaggedError("EnqueueHaltedError")<{
  reason: string;
}> {
  override get message() {
    return `Enqueued mutation halted with ${this.reason}`;
  }
}

/** An RPC provider serves a different chain than `config.chainId`. */
export class ChainIdMismatchError extends Data.TaggedError(
  "ChainIdMismatchError",
)<{
  origin: string;
  expected: number;
  actual: number;
}> {
  override get message() {
    return `RPC ${this.origin} serves chain ${this.actual}, but config.chainId is ${this.expected}`;
  }
}

/** A settlement transaction was mined but reverted onchain. */
export class SettlementRevertedError extends Data.TaggedError(
  "SettlementRevertedError",
)<{
  transactionHash: Hex.Hex;
}> {
  override get message() {
    return `Settlement transaction ${this.transactionHash} reverted onchain`;
  }
}

/**
 * `program` stopped, so a waiting `execute` will never get an answer. `cause`
 * is how the program exited: a {@link ProgramError}, or an interruption.
 */
export class TypewriterStoppedError extends Data.TaggedError(
  "TypewriterStoppedError",
)<{
  cause: Cause.Cause<ProgramError>;
}> {
  override get message() {
    return "Typewriter stopped";
  }
}

/** Why `execute` did not accept a mutation. */
export type ExecuteError =
  | UnknownMutationError
  | ExecuteMutationError
  | TypewriterStoppedError;

export type ProgramError =
  | WatchError
  | DbError
  | EvmError
  | SettlementSimulationRevertedError
  | SettlementSimulationHaltedError
  | SettlementRevertedError
  | EnqueueRevertedError
  | EnqueueHaltedError
  | SignTransactionError
  | ProgramStoppedError;

export type CreateTypewriterError =
  | DbError
  | RpcError
  | BlockNotFoundError
  | IncompleteBlockError
  | NoDataReturnedError
  | MigrationError
  | ChainIdMismatchError
  | EvmError;

/**
 * Moves `mutation` to the `to` status in place, so the batches and blocks
 * that hold it see the change. `fields` are the fields that `to` adds.
 */
function updateMutation<
  from extends RuntimeMutation,
  to extends RuntimeMutation,
>(mutation: from, fields: Omit<to, Exclude<keyof from, "status">>): to {
  // @ts-expect-error `from` and `to` have different statuses, and `fields` sets it.
  return Object.assign(mutation, fields);
}

export function updateMutationToAccepted(
  mutation: ReceivedMutation,
  params: {
    executionIndex: bigint;
    journalId: number;
  },
): AcceptedMutation {
  return updateMutation<ReceivedMutation, AcceptedMutation>(mutation, {
    status: "accepted",
    executionIndex: params.executionIndex,
    journalId: params.journalId,
  });
}

export function updateMutationToRejected(
  mutation: ReceivedMutation,
  params: { error: ExecuteMutationError },
): RejectedMutation {
  return updateMutation<ReceivedMutation, RejectedMutation>(mutation, {
    status: "rejected",
    error: params.error,
  });
}

export function updateMutationToIncluded(
  mutation: AcceptedMutation,
  inclusion: Inclusion,
): IncludedMutation {
  return updateMutation<AcceptedMutation, IncludedMutation>(mutation, {
    ...inclusion,
    status: "included",
  });
}

export function updateMutationToFinalized(
  mutation: IncludedMutation,
): IncludedMutation {
  mutation.status = "finalized";
  return mutation;
}

/** `mutation` as it was before it executed, to execute it again. */
function toUnexecuted(mutation: AcceptedMutation): ReceivedMutation {
  const { name, params, authorization, config } = mutation;
  return { name, params, authorization, config, status: "received" };
}

export function mutationToEvent(mutation: RuntimeMutation): MutationEvent {
  const {
    config: _config,
    journalId: _journalId,
    ...event
  } = mutation as RuntimeMutation & { journalId?: number };
  return event as MutationEvent;
}

export function batchToEvent(batch: RuntimeBatch): BatchEvent {
  return {
    ...batch,
    mutations: batch.mutations.map(mutationToEvent),
  } as BatchEvent;
}

export function fifoBlockToEvent(
  block: RuntimeBlock<"fifo">,
): BlockEvent<"fifo"> {
  const { mutations, ...rest } = block;
  return {
    ...rest,
    mutations: mutations.map(mutationToEvent),
  } as BlockEvent<"fifo">;
}

export function batchBlockToEvent(
  block: RuntimeBlock<"batch">,
): BlockEvent<"batch"> {
  return {
    status: block.status,
    number: block.number,
    hash: block.hash,
    timestamp: block.timestamp,
    transactionHash: block.transactionHash,
    batches: block.batches.map(batchToEvent),
  } as BlockEvent<"batch">;
}

export class EncodeMutationError extends Data.TaggedError(
  "EncodeMutationError",
)<{
  mutation: ReceivedMutation;
  cause: unknown;
}> {
  override get message() {
    return `Failed to encode '${this.mutation.name}' mutation`;
  }
}

/** A mutation reverted when executed in revm. */
export class MutationRevertedError extends Data.TaggedError(
  "MutationRevertedError",
)<Revert> {
  override get message() {
    return revertMessage("Mutation reverted", this);
  }
}

/** A mutation halted when executed in revm, e.g. on an invalid opcode. */
export class MutationHaltedError extends Data.TaggedError(
  "MutationHaltedError",
)<{
  reason: string;
}> {
  override get message() {
    return `Mutation halted with ${this.reason}`;
  }
}

/**
 * A mutation's authorization or credential expires within
 * {@link EXPIRATION_MARGIN} seconds of the latest block, so it could expire
 * before its settlement lands.
 */
export class MutationExpiresTooSoonError extends Data.TaggedError(
  "MutationExpiresTooSoonError",
)<{
  expiration: bigint;
  minExpiration: bigint;
}> {
  override get message() {
    return `Mutation expires at ${this.expiration}, before ${this.minExpiration}`;
  }
}

export type ExecuteMutationError =
  | EncodeMutationError
  | EvmError
  | MutationRevertedError
  | MutationHaltedError
  | MutationExpiresTooSoonError;

/** The `execute` calldata of `mutation`. Fails if a field is malformed. */
export function encodeMutation(
  mutation: ReceivedMutation,
): Effect.Effect<Hex.Hex, EncodeMutationError> {
  return Effect.try({
    try: () => encodeExecuteCalldata([encodeBatchArg([mutation])], []),
    catch: (cause) => new EncodeMutationError({ mutation, cause }),
  });
}

export function executeMutation(params: {
  app: TypewriterApp;
  evm: EVM;
  mutation: ReceivedMutation;
  /** The calldata from {@link encodeMutation}. */
  calldata: Hex.Hex;
  /** The index the mutation takes if it executes. */
  executionIndex: bigint;
}): Effect.Effect<
  {
    mutation: AcceptedMutation;
    executeResult: ExecuteResult;
  },
  EvmError | MutationRevertedError | MutationHaltedError
> {
  return Effect.gen(function* () {
    const executeStartedAt = yield* startTimer;
    const executeResult = yield* params.evm.execute({
      from: params.app.account.address,
      to: params.app.address,
      data: params.calldata,
    });

    if (executeResult.status === "revert") {
      return yield* new MutationRevertedError(
        decodeRevert(params.app.abi, executeResult.data),
      );
    }
    if (executeResult.status === "halt") {
      return yield* new MutationHaltedError({ reason: executeResult.reason });
    }

    const acceptedMutation = updateMutationToAccepted(params.mutation, {
      executionIndex: params.executionIndex,
      journalId: executeResult.journal_id,
    });

    yield* Effect.logDebug("Executed mutation").pipe(
      Effect.annotateLogs({
        mutation: acceptedMutation.name,
        execution_index: acceptedMutation.executionIndex,
        slot_write_count: executeResult.slot_writes.length,
        duration: yield* durationMs(executeStartedAt),
      }),
    );

    return {
      mutation: acceptedMutation,
      executeResult,
    };
  });
}

/** The arguments of an `enqueue` call, from its `ForceInclusionQueued` log. */
type ForceInclusionQueued = {
  index: bigint;
  mutation: number;
  mutationData: Hex.Hex;
  authorizationData: Hex.Hex;
};

export function decodeForceInclusionQueued(
  log: LocalLog,
): ForceInclusionQueued {
  return decodeEventLog({
    abi: TYPEWRITER_ABI,
    eventName: "ForceInclusionQueued",
    topics: log.topics,
    data: log.data,
    strict: true,
  }).args;
}

/** Replays an `enqueue` in revm with the bytes it had onchain. */
export function enqueueMutation(params: {
  app: TypewriterApp;
  evm: EVM;
  queued: ForceInclusionQueued;
}): Effect.Effect<ExecuteResult, EvmError> {
  return Effect.gen(function* () {
    const executeResult = yield* params.evm.execute({
      from: "0x0000000000000000000000000000000000000000",
      to: params.app.address,
      data: encodeEnqueueCalldata(params.queued),
    });

    // The enqueue is already onchain, so a settlement never rewinds it.
    if (executeResult.status === "success") {
      yield* params.evm.pruneJournals({
        journal_ids: [executeResult.journal_id],
      });
    }

    return executeResult;
  });
}

const SLOT_CACHE_MAX_ENTRIES = 200_000;

/** Revert data from revm, decoded against the app's ABI when it matches. */
type Revert = {
  data: Hex.Hex;
  /** The custom error's name, or `Error`/`Panic` for the built-in ones. */
  errorName: string | undefined;
  args: readonly unknown[] | undefined;
};

function decodeRevert(abi: Abi, data: Hex.Hex): Revert {
  try {
    const { errorName, args } = decodeErrorResult({ abi, data });
    return { data, errorName, args };
  } catch {
    // Empty revert data, or a selector that isn't in the ABI.
    return { data, errorName: undefined, args: undefined };
  }
}

/** `prefix`, and the decoded error with its arguments, like `Error("reason")`. */
function revertMessage(prefix: string, revert: Revert) {
  if (revert.errorName === undefined) return prefix;
  const args = (revert.args ?? [])
    .map((arg) => (typeof arg === "string" ? JSON.stringify(arg) : String(arg)))
    .join(", ");
  return `${prefix} with ${revert.errorName}(${args})`;
}

function createRuntimeState(
  app: TypewriterApp,
  db: Db,
  code: Hex.Hex,
  startBlock: Pick<RequestedBlock, "number" | "timestamp">,
): Effect.Effect<
  {
    evm: EVM;
    accounts: StorageView<StorageLayout, false>[string];
    state: StorageView<StorageLayout, false>[string];
    /**
     * The keccak256 preimages the storage view enumerates mapping keys from.
     * Add the preimages of each accepted mutation.
     */
    preimages: Set<Hex.Hex>;
    invalidateStorageCache: (slots?: readonly Hex.Hex[]) => void;
  },
  DbError | EvmError
> {
  return Effect.gen(function* () {
    const { initialAccountStorage, preimages } = yield* db.transaction((tx) =>
      Effect.gen(function* () {
        const preimages = yield* selectKeccakPreimages(
          tx,
          app.typewriterSchema,
        );
        const initialAccountStorage = yield* selectStorageSlots(
          tx,
          app.typewriterSchema,
        );

        return {
          preimages: new Set(preimages),
          initialAccountStorage,
        };
      }),
    );

    if (code === "0x") {
      yield* Effect.logWarning(
        "Detected no contract code at the typewriter address; mutations will execute without it",
      ).pipe(Effect.annotateLogs({ address: app.address }));
    }
    const evm = yield* createEVM({
      spec: app.hardfork,
      chain_id: app.chainId,
      // Until the watch reports the next block, mutations execute in the
      // start block, so checks against `block.timestamp`, such as
      // authorization expiry, see a real time.
      block: {
        number: Hex.fromNumber(startBlock.number),
        timestamp: Hex.fromNumber(startBlock.timestamp),
      },
      accounts: {
        [app.address]: {
          code: code === "0x" ? undefined : code,
          storage: initialAccountStorage,
        },
      },
    });

    const slotCache = new Map<Hex.Hex, Hex.Hex>();
    const invalidateStorageCache = (slots?: readonly Hex.Hex[]) => {
      if (slots === undefined) {
        slotCache.clear();
        return;
      }

      for (const slot of slots) {
        slotCache.delete(slot);
      }
    };

    const storageProxy = createStorageView(
      app.storageLayout,
      (slots) => {
        const missingSlots = slots.filter((slot) => !slotCache.has(slot));
        if (missingSlots.length > 0) {
          const fetched = Effect.runSync(
            evm.readStorage({ address: app.address, slots: missingSlots }),
          );
          for (const [slot, value] of Object.entries(fetched) as [
            Hex.Hex,
            Hex.Hex,
          ][]) {
            slotCache.set(slot, value);
          }

          while (slotCache.size > SLOT_CACHE_MAX_ENTRIES) {
            const oldestSlot = slotCache.keys().next().value;
            slotCache.delete(oldestSlot!);
          }
        }

        return slots.map((slot) => slotCache.get(slot)!);
      },
      preimages,
    );

    return {
      evm,
      // biome-ignore lint/complexity/useLiteralKeys: generic storage layouts expose root variables through an index signature.
      accounts: storageProxy["accounts"],
      // biome-ignore lint/complexity/useLiteralKeys: generic storage layouts expose root variables through an index signature.
      state: storageProxy["state"],
      preimages,
      invalidateStorageCache,
    };
  });
}

function batchBlockToFifoBlock(
  block: RuntimeBlock<"batch">,
): RuntimeBlock<"fifo"> {
  const { batches, ...rest } = block;
  return {
    ...rest,
    mutations: batches.flatMap(
      (batch) => batch.mutations as IncludedMutation[],
    ),
  };
}

export function createTypewriterEffect<
  const storageConfig extends StorageConfig,
  const mutationsConfig extends MutationsConfig,
  const sequencingConfig extends SequencingConfig,
>(
  app: TypewriterApp,
): Effect.Effect<
  TypewriterEffect<storageConfig, mutationsConfig, sequencingConfig>,
  CreateTypewriterError,
  Database | Rpc | Scope.Scope
> {
  return Effect.gen(function* () {
    // TODO(kyle) check mutation names against sequencing order if applicable
    // TODO(kyle) validate the fixed Typewriter entrypoints

    const db = yield* Database;
    const rpc = yield* Rpc;
    const scope = yield* Scope.Scope;

    // revm picks its hardfork from `app.chainId`, so every provider must serve
    // that chain.
    const chainIds = yield* rpc.requestEach({ method: "eth_chainId" });
    for (const { origin, result } of chainIds) {
      const actual = Hex.toNumber(result);
      if (actual !== app.chainId) {
        return yield* new ChainIdMismatchError({
          origin,
          expected: app.chainId,
          actual,
        });
      }
    }

    const lockLost = yield* db.lock(
      deploymentLockKey(app.schemaName),
      DEPLOYMENT_LOCK_TIMEOUT_MS,
    );
    if (app.dev) {
      // The schema lasts as long as this process's chain. The finalizer runs
      // before the lock is released, since it is added after it.
      yield* Effect.addFinalizer(() =>
        dropSchema(db, app.schemaName).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("Failed to drop dev schema", cause),
          ),
        ),
      );
    }

    // The runtime starts from this block, and watches the blocks after it.
    // Read it by hash, so each read sees the same block on any provider.
    const startBlock = yield* requestBlock("latest");
    const code = yield* rpc.request({
      method: "eth_getCode",
      params: [app.address, { blockHash: startBlock.hash }],
    });
    let nextExecutionIndex = yield* requestExecutionIndex(
      app.address,
      startBlock.hash,
    );
    yield* migrate(
      db,
      app.schemaName,
      app.typewriterSchema,
      app.mutationSchema,
      {
        chainId: app.chainId,
        address: app.address,
        codeHash: Hash.keccak256(code),
      },
      nextExecutionIndex,
    );

    const { evm, accounts, state, preimages, invalidateStorageCache } =
      yield* createRuntimeState(app, db, code, startBlock);
    /** The timestamp of the block that mutations execute in. */
    let blockTimestamp = startBlock.timestamp;

    const watch = yield* makeWatch({
      fromBlock: startBlock.hash,
      pollIntervalMs: app.blockPollingIntervalMs,
      maxChainDepth: app.confirmations.finalizedBlockDepth,
      logFilter: {
        address: app.address,
        selector: toEventSelector(
          getAbiItem({ abi: TYPEWRITER_ABI, name: "ForceInclusionQueued" }),
        ),
      },
    });
    let batchId = 0;
    let batchPosition = 0;

    const batchesById = new Map<number, RuntimeBatch>();
    // `execute` checks a mutation's name, then the shape of its input,
    // before it queues it: an input that passes encodes to the bytes it means.
    // Not `app.mutations[name]`, which finds `Object.prototype` names too.
    const isMutationName = Schema.is(
      Schema.Literals(Object.keys(app.mutations)),
    );
    const executeInputSchemas = new Map(
      Object.entries(app.mutations).map(([name, config]) => [
        name,
        executeInputSchema(config.params),
      ]),
    );
    /** The journals of each block's force-executed enqueues, pruned with it. */
    const forceExecutedJournalIds = new Map<RuntimeBlock<"batch">, number[]>();
    const receivedMutationQueue = yield* Queue.unbounded<{
      mutation: ReceivedMutation;
      deferred: AcceptDeferred;
    }>();
    /** The queue index of each `enqueue` the watch has seen, in order. */
    const enqueuedQueue = yield* Queue.unbounded<bigint>();
    const acceptedBatchesQueue = yield* Queue.unbounded<{
      id: number;
      committed: Deferred.Deferred<void>;
    }>();
    const persistQueue = yield* Queue.unbounded<{
      write: (tx: DbTransaction) => Effect.Effect<void, DbError>;
      committed: Deferred.Deferred<void>;
    }>();
    yield* Scope.addFinalizer(scope, Queue.shutdown(receivedMutationQueue));
    yield* Scope.addFinalizer(scope, Queue.shutdown(enqueuedQueue));
    yield* Scope.addFinalizer(scope, Queue.shutdown(acceptedBatchesQueue));
    yield* Scope.addFinalizer(scope, Queue.shutdown(persistQueue));
    const stopped = yield* Deferred.make<never, TypewriterStoppedError>();

    const withSpeculativeStateLock = Semaphore.withPermits(
      yield* Semaphore.make(1),
      1,
    );
    const withSubmitLock = Semaphore.withPermits(yield* Semaphore.make(1), 1);

    const builtInMutationOrder = [
      "CreateAccount",
      "AddCredential",
      "RemoveCredential",
    ];
    const batchOrder =
      app.sequencing.order === "batch"
        ? [
            ...builtInMutationOrder,
            ...app.sequencing.batchOrder.filter(
              (name) => !builtInMutationOrder.includes(name),
            ),
          ]
        : [];
    const batchOrderByName = new Map(
      batchOrder.map((name, position) => [name, position]),
    );

    let nonce = yield* rpc
      .request({
        method: "eth_getTransactionCount",
        params: [app.account.address, "latest"],
      })
      .pipe(Effect.map(Hex.toNumber));

    let unfinalizedBlocks: RuntimeBlock<"batch">[] = [];
    const mutationListeners = new Set<MutationListener>();
    const batchListeners = new Set<BatchListener>();
    const blockListeners = new Set<BlockListener<"fifo" | "batch">>();

    // A listener is the caller's code, so its error can't stop the runtime.
    // Nothing else sees the error, so it is a warning. A listener typed to
    // return `void` can still be async, and its rejection would otherwise
    // crash the process.
    const emit = <event>(
      name: "mutation" | "batch" | "block",
      listeners: ReadonlySet<(event: event) => void>,
      event: event,
    ) =>
      Effect.gen(function* () {
        const context = yield* Effect.context<never>();
        const warn = (error: unknown) =>
          Effect.logWarning("Failed event listener", error).pipe(
            Effect.annotateLogs({ event: name }),
          );
        yield* Effect.forEach(
          listeners,
          (cb) =>
            Effect.try({
              try: () => {
                const result: unknown = cb(event);
                if (Predicate.isPromise(result)) {
                  result.catch((error) =>
                    Effect.runForkWith(context)(warn(error)),
                  );
                }
              },
              catch: (error) => error,
            }).pipe(Effect.catch(warn)),
          { discard: true },
        );
      });

    const emitMutation = (event: MutationEvent) =>
      emit("mutation", mutationListeners, event);

    const emitBatch = (event: BatchEvent) =>
      app.sequencing.order === "batch"
        ? emit("batch", batchListeners, event)
        : Effect.void;

    const emitBlock = (block: RuntimeBlock<"batch">) =>
      emit(
        "block",
        blockListeners,
        (app.sequencing.order === "fifo"
          ? fifoBlockToEvent(batchBlockToFifoBlock(block))
          : batchBlockToEvent(block)) as BlockEvent<"fifo" | "batch">,
      );

    // Fails if the authorization or its credential expires before
    // `minExpiration`. The credential is read from speculative state, so one
    // added earlier in the batch counts. A missing credential is left to revm.
    function checkExpiration(
      mutation: ReceivedMutation,
      minExpiration: bigint,
    ): Effect.Effect<void, MutationExpiresTooSoonError> {
      return Effect.gen(function* () {
        const { authorization } = mutation;
        if (
          authorization.expiration !== 0n &&
          authorization.expiration < minExpiration
        ) {
          return yield* new MutationExpiresTooSoonError({
            expiration: authorization.expiration,
            minExpiration,
          });
        }

        if (mutation.name === "CreateAccount") return;
        const { credentials } = (
          accounts as unknown as Record<
            Hex.Hex,
            {
              credentials: {
                length: number;
                [index: number]: { expiration: number };
              };
            }
          >
        )[authorization.accountID]!;
        if (authorization.credentialID >= BigInt(credentials.length)) return;
        const credentialExpiration = BigInt(
          credentials[Number(authorization.credentialID)]!.expiration,
        );
        if (
          credentialExpiration !== 0n &&
          credentialExpiration < minExpiration
        ) {
          return yield* new MutationExpiresTooSoonError({
            expiration: credentialExpiration,
            minExpiration,
          });
        }
      });
    }

    // Executes a mutation against speculative state and updates in-memory
    // bookkeeping, but performs no database writes. Persistence is batched by
    // the caller (`acceptBatch`, `submit`, and `watch`) so many mutations share
    // a single set of insert statements.
    function acceptMutation(
      mutation: ReceivedMutation,
      /** Rejects the mutation if it expires before this timestamp. */
      minExpiration?: bigint,
    ): Effect.Effect<AcceptedExecution, ExecuteMutationError> {
      return Effect.gen(function* () {
        const { executeResult, mutation: acceptedMutation } = yield* Effect.gen(
          function* () {
            const calldata = yield* encodeMutation(mutation);
            // The mutation encodes, so its authorization is well-formed to
            // read the account state with.
            if (minExpiration !== undefined) {
              yield* checkExpiration(mutation, minExpiration);
            }
            // TODO: Validate the fixed Authorization against the mirrored
            // account state before entering revm, then retain contract
            // execution as the final authority. The static wire shape makes
            // this a future fast-rejection path.
            return yield* executeMutation({
              app,
              evm,
              mutation,
              calldata,
              executionIndex: nextExecutionIndex,
            });
          },
        ).pipe(
          Effect.tapError((error) =>
            Effect.suspend(() => {
              const rejectedMutation = updateMutationToRejected(mutation, {
                error,
              });

              return emitMutation(mutationToEvent(rejectedMutation));
            }),
          ),
        );

        nextExecutionIndex++;
        const newPreimages = recordExecution(executeResult);

        yield* emitMutation(mutationToEvent(acceptedMutation));

        return {
          mutation: acceptedMutation,
          executeResult,
          preimages: newPreimages,
        };
      });
    }

    /** Updates the caches for an execution. Returns its new preimages. */
    function recordExecution(executeResult: ExecuteResult): Hex.Hex[] {
      invalidateStorageCache(
        executeResult.slot_writes.map((write) => write.slot),
      );

      const newPreimages: Hex.Hex[] = [];
      for (const preimage of executeResult.keccak_preimages) {
        if (preimages.has(preimage)) continue;
        preimages.add(preimage);
        newPreimages.push(preimage);
      }
      return newPreimages;
    }

    // Force-executes the enqueue at `queueIndex`. The runtime never decodes
    // an enqueue: revm runs the contract on its bytes and decides whether it
    // executes. It has no event and no mutation row, but its writes settle
    // like any other.
    function forceExecute(queueIndex: bigint) {
      return Effect.gen(function* () {
        const executeResult = yield* evm.execute({
          from: app.account.address,
          to: app.address,
          data: encodeExecuteCalldata([], [queueIndex]),
        });
        if (executeResult.status !== "success") {
          yield* Effect.logWarning(
            executeResult.status === "revert"
              ? revertMessage(
                  "Discarded enqueued mutation",
                  decodeRevert(app.abi, executeResult.data),
                )
              : `Discarded enqueued mutation, which halted with ${executeResult.reason}`,
          ).pipe(Effect.annotateLogs({ queue_index: queueIndex }));
          // TODO(kyle) the discarded mutation stays in the queue onchain,
          // and anyone can `forceExecute` it after `FORCE_INCLUSION_DELAY` seconds.
          // It can succeed then, for example once its nonce is next, and
          // change state and `executionIndex` outside revm. The watch only
          // sees `ForceInclusionQueued` logs and `forceExecute` emits no
          // event, so revm would not see it.
          return undefined;
        }

        const executionIndex = nextExecutionIndex++;
        yield* Effect.logDebug("Force-executed enqueued mutation").pipe(
          Effect.annotateLogs({
            queue_index: queueIndex,
            execution_index: executionIndex,
          }),
        );
        return {
          queueIndex,
          mutation: { executionIndex },
          executeResult,
          preimages: recordExecution(executeResult),
        };
      });
    }

    /** An enqueue that executed against the speculative state. */
    type ForceExecution = NonNullable<
      Effect.Success<ReturnType<typeof forceExecute>>
    >;

    const persist = (
      write: (tx: DbTransaction) => Effect.Effect<void, DbError>,
    ) =>
      Effect.gen(function* () {
        const committed = yield* Deferred.make<void>();
        yield* Queue.offer(persistQueue, { write, committed });
        return committed;
      });

    const acceptBatch = (
      submittedMutations: {
        mutation: ReceivedMutation;
        deferred: AcceptDeferred;
      }[],
    ) =>
      withSpeculativeStateLock(
        Effect.gen(function* () {
          const batchStartedAt = yield* startTimer;

          if (submittedMutations.length === 0) {
            return;
          }

          if (batchOrder.length > 0) {
            submittedMutations.sort(
              (a, b) =>
                (batchOrderByName.get(a.mutation.name) ?? batchOrder.length) -
                (batchOrderByName.get(b.mutation.name) ?? batchOrder.length),
            );
          }

          const acceptedMutations: (AcceptedExecution & {
            deferred: AcceptDeferred;
          })[] = [];

          const minExpiration = blockTimestamp + BigInt(EXPIRATION_MARGIN);
          for (const { mutation, deferred } of submittedMutations) {
            const result = yield* Effect.result(
              acceptMutation(mutation, minExpiration),
            );
            if (Result.isSuccess(result)) {
              acceptedMutations.push({ ...result.success, deferred });
            } else {
              yield* Deferred.fail(deferred, result.failure);
            }
          }

          if (acceptedMutations.length === 0) {
            return;
          }

          const batch: RuntimeBatch = {
            status: "accepted",
            id: batchId++,
            position: batchPosition++,
            mutations: acceptedMutations.map(({ mutation }) => mutation),
          };

          yield* Effect.logDebug("Created batch").pipe(
            Effect.annotateLogs({
              batch_id: batch.id,
              mutation_count: batch.mutations.length,
              duration: yield* durationMs(batchStartedAt),
            }),
          );

          batchesById.set(batch.id, batch);

          yield* emitBatch(batchToEvent(batch));

          const committed = yield* persist((tx) =>
            Effect.gen(function* () {
              yield* insertMutations(
                tx,
                app.mutationSchema,
                acceptedMutations.map((entry) => entry.mutation),
              );
              yield* insertStorageSlots(
                tx,
                app.typewriterSchema,
                acceptedMutations,
              );
              yield* insertKeccakPreimages(
                tx,
                app.typewriterSchema,
                acceptedMutations.flatMap(({ preimages }) => preimages),
              );
            }),
          );
          yield* Queue.offer(acceptedBatchesQueue, { id: batch.id, committed });
          for (const { mutation, deferred } of acceptedMutations) {
            yield* Deferred.succeed(deferred, { mutation, committed });
          }
        }),
      );

    // Rewinds the speculative state to before the unsubmitted mutations and
    // enqueues, then executes them again in order at the current block and
    // drops the ones that fail now. The rest may take new execution indexes.
    // They hold the newest journals, so reverting them restores the state the
    // submitted ones left, and the queue entries of the enqueues. Enqueues
    // since then only added queue entries, which these journals never touch.
    // TODO(kyle) `execute` already returned the old execution index, and a
    // dropped mutation goes from `accepted` to `rejected`.
    const reexecute = (
      batches: RuntimeBatch[],
      forceExecuted: ForceExecution[],
    ) =>
      Effect.gen(function* () {
        const pending = batches.flatMap(
          (batch) => batch.mutations as AcceptedMutation[],
        );
        const fromExecutionIndex = (pending[0] ?? forceExecuted[0]!.mutation)
          .executionIndex;
        yield* evm.revertJournals({
          journal_ids: [
            ...pending.map((mutation) => mutation.journalId),
            ...forceExecuted.map(
              ({ executeResult }) => executeResult.journal_id,
            ),
          ],
        });
        invalidateStorageCache();
        nextExecutionIndex = fromExecutionIndex;

        const executed: AcceptedExecution[] = [];
        for (const batch of batches) {
          const kept: AcceptedMutation[] = [];
          for (const mutation of batch.mutations as AcceptedMutation[]) {
            const result = yield* Effect.result(
              acceptMutation(toUnexecuted(mutation)),
            );
            if (Result.isFailure(result)) continue;
            executed.push(result.success);
            kept.push(result.success.mutation);
          }
          batch.mutations = kept;
          if (batch.mutations.length === 0) batchesById.delete(batch.id);
        }
        const keptForceExecuted: ForceExecution[] = [];
        for (const { queueIndex } of forceExecuted) {
          const reexecuted = yield* forceExecute(queueIndex);
          if (reexecuted !== undefined) keptForceExecuted.push(reexecuted);
        }

        const committed = yield* persist((tx) =>
          Effect.gen(function* () {
            yield* deleteExecutionsFrom(
              tx,
              app.mutationSchema,
              app.typewriterSchema,
              fromExecutionIndex,
            );
            yield* insertMutations(
              tx,
              app.mutationSchema,
              executed.map((entry) => entry.mutation),
            );
            yield* insertStorageSlots(tx, app.typewriterSchema, [
              ...executed,
              ...keptForceExecuted,
            ]);
            yield* insertKeccakPreimages(
              tx,
              app.typewriterSchema,
              [...executed, ...keptForceExecuted].flatMap(
                ({ preimages }) => preimages,
              ),
            );
          }),
        );

        return {
          batches: batches.filter((batch) => batch.mutations.length > 0),
          forceExecuted: keptForceExecuted,
          committed,
          droppedCount:
            pending.length +
            forceExecuted.length -
            executed.length -
            keptForceExecuted.length,
        };
      });

    const submit = Effect.gen(function* () {
      const simulation = yield* withSpeculativeStateLock(
        Effect.gen(function* () {
          const acceptedBatches = yield* Queue.clear(acceptedBatchesQueue);
          const queueIndexes = yield* Queue.clear(enqueuedQueue);
          if (acceptedBatches.length === 0 && queueIndexes.length === 0) {
            return undefined;
          }

          let batches = acceptedBatches.map(({ id }) => batchesById.get(id)!);
          const commits = acceptedBatches.map(({ committed }) => committed);

          /** The enqueues that execute, in the order the settlement runs them. */
          let forceExecuted: ForceExecution[] = [];
          for (const queueIndex of queueIndexes) {
            const executed = yield* forceExecute(queueIndex);
            if (executed !== undefined) forceExecuted.push(executed);
          }

          if (forceExecuted.length > 0) {
            commits.push(
              yield* persist((tx) =>
                Effect.gen(function* () {
                  yield* insertStorageSlots(
                    tx,
                    app.typewriterSchema,
                    forceExecuted,
                  );
                  yield* insertKeccakPreimages(
                    tx,
                    app.typewriterSchema,
                    forceExecuted.flatMap(({ preimages }) => preimages),
                  );
                }),
              ),
            );
          }

          // Each mutation executed when it was accepted, so the settlement
          // reverts only when one fails in a later block, e.g. on an
          // authorization that expired since. Then execute them again, drop
          // the ones that fail, and simulate what is left.
          while (true) {
            if (batches.length === 0 && forceExecuted.length === 0) {
              return undefined;
            }

            const speculativeJournalIds = batches
              .flatMap((batch) => batch.mutations)
              .map((mutation) => mutation.journalId)
              .concat(
                forceExecuted.map(
                  ({ executeResult }) => executeResult.journal_id,
                ),
              );

            // TODO(kyle) cap a submission at the block gas limit. Every pending
            // batch and enqueued mutation goes into one transaction, so after a
            // backlog the node rejects it ("intrinsic gas too high") and the
            // retries fail the program.
            const calldata = encodeExecuteCalldata(
              batches.map((batch) => encodeBatchArg(batch.mutations)),
              forceExecuted.map(({ queueIndex }) => queueIndex),
            );

            const simulationStartedAt = yield* startTimer;
            const simulateResult = yield* evm.simulate({
              from: app.account.address,
              to: app.address,
              data: calldata,
              journal_ids: speculativeJournalIds,
            });
            const duration = yield* durationMs(simulationStartedAt);
            if (simulateResult.status === "halt") {
              return yield* new SettlementSimulationHaltedError({
                reason: simulateResult.reason,
              });
            }
            if (simulateResult.status === "success") {
              yield* Effect.logDebug("Simulated settlement transaction").pipe(
                Effect.annotateLogs({
                  nonce,
                  gas_limit: simulateResult.gas_limit,
                  batch_count: batches.length,
                  mutation_count: speculativeJournalIds.length,
                  duration,
                }),
              );

              return {
                batches,
                forceExecuted,
                calldata,
                simulateResult,
                commits,
              };
            }

            const error = new SettlementSimulationRevertedError(
              decodeRevert(app.abi, simulateResult.data),
            );
            const reexecuted = yield* reexecute(batches, forceExecuted);
            if (reexecuted.droppedCount === 0) return yield* error;
            yield* Effect.logWarning(
              "Dropped mutations from a reverted settlement",
              error,
            ).pipe(
              Effect.annotateLogs({
                dropped_count: reexecuted.droppedCount,
                mutation_count: speculativeJournalIds.length,
              }),
            );

            batches = reexecuted.batches;
            forceExecuted = reexecuted.forceExecuted;
            commits.push(reexecuted.committed);
          }
        }),
      );

      if (simulation === undefined) return;

      const { batches, forceExecuted, calldata, simulateResult, commits } =
        simulation;

      yield* Effect.forEach(commits, Deferred.await, { discard: true });

      const transactionStartedAt = yield* startTimer;

      const filled = yield* rpc.request({
        method: "eth_fillTransaction",
        params: [
          {
            from: app.account.address,
            to: app.address,
            data: calldata,
            gas: Hex.fromNumber(simulateResult.gas_limit),
            nonce: Hex.fromNumber(nonce),
            accessList: simulateResult.access_list,
          },
        ],
      });

      // `eth_fillTransaction` returns an already-signed `raw`; strip its
      // signature fields so the account re-signs over the correct payload.
      const transaction = parseTransaction(filled.raw);
      // The RPC backing `eth_fillTransaction` can be out of sync with the one
      // backing the send, so the nonce it fills may be stale and override our
      // clamp. Force our locally reconciled nonce onto the transaction so the
      // broadcast nonce is exactly the value we tracked, independent of fill's
      // view of the pending pool.
      delete transaction.r;
      delete transaction.s;
      delete transaction.v;
      delete transaction.yParity;
      const signed = yield* Effect.tryPromise({
        try: () => app.account.signTransaction(transaction),
        catch: (cause) => new SignTransactionError({ cause }),
      });
      const hash = Hash.keccak256(signed as Hex.Hex);

      let broadcastAttempted = false;
      const receipt = yield* Effect.gen(function* () {
        if (broadcastAttempted) {
          const receipt = yield* rpc.request({
            method: "eth_getTransactionReceipt",
            params: [hash],
          });
          if (receipt !== null) return receipt;
        }

        broadcastAttempted = true;
        return yield* rpc.request({
          method: "eth_sendRawTransactionSync",
          params: [signed],
        });
      }).pipe(
        Effect.tapError((error) =>
          Effect.logDebug("Failed settlement submission", error).pipe(
            Effect.annotateLogs({ transaction_hash: hash }),
          ),
        ),
        Effect.retry({ times: SUBMIT_RETRY_TIMES }),
        Effect.map(formatTransactionReceipt),
      );

      nonce += 1;

      if (receipt.status === "reverted") {
        return yield* new SettlementRevertedError({
          transactionHash: receipt.transactionHash,
        });
      }
      const duration = yield* durationMs(transactionStartedAt);

      yield* Effect.logDebug("Submitted settlement transaction").pipe(
        Effect.annotateLogs({
          transaction_hash: receipt.transactionHash,
          block_number: receipt.blockNumber,
          duration,
        }),
      );

      const block = yield* requestBlock(receipt.blockHash).pipe(
        Effect.provideService(Rpc, rpc),
      );

      const inclusion: Inclusion = {
        blockNumber: block.number,
        blockHash: block.hash,
        blockTimestamp: block.timestamp,
        transactionHash: receipt.transactionHash,
        transactionIndex: receipt.transactionIndex,
      };

      for (const batch of batches) {
        batch.status = "included";
        for (const mutation of batch.mutations) {
          updateMutationToIncluded(mutation as AcceptedMutation, inclusion);
        }
      }

      const runtimeBlock: RuntimeBlock<"batch"> = {
        status: "included",
        number: block.number,
        hash: block.hash,
        timestamp: block.timestamp,
        transactionHash: receipt.transactionHash,
        batches,
      };
      if (forceExecuted.length > 0) {
        forceExecutedJournalIds.set(
          runtimeBlock,
          forceExecuted.map(({ executeResult }) => executeResult.journal_id),
        );
      }

      yield* persist((tx) =>
        updateMutationInclusion(
          tx,
          app.mutationSchema,
          batches.flatMap((batch) => batch.mutations),
          inclusion,
        ),
      );

      yield* emitBlock(runtimeBlock);
      for (const batch of batches) {
        yield* emitBatch(batchToEvent(batch));
        for (const mutation of batch.mutations) {
          yield* emitMutation(mutationToEvent(mutation));
        }
      }

      unfinalizedBlocks.push(runtimeBlock);
    });

    const watchProgram = Effect.gen(function* () {
      yield* watch.messages.pipe(
        Stream.runForEach((message) =>
          Effect.gen(function* () {
            if (message._tag === "Reorged") {
              return;
            }

            yield* evm.setBlockContext({
              number: Hex.fromNumber(message.block.number),
              timestamp: Hex.fromNumber(message.block.timestamp),
            });
            blockTimestamp = message.block.timestamp;

            for (const log of message.block.logs) {
              const queued = decodeForceInclusionQueued(log);

              // Every enqueue takes a queue index onchain, so revm replays
              // each one with its bytes. `submit` force-executes it.
              const executeResult = yield* withSpeculativeStateLock(
                enqueueMutation({ app, evm, queued }),
              );

              if (executeResult.status === "revert") {
                return yield* new EnqueueRevertedError(
                  decodeRevert(app.abi, executeResult.data),
                );
              }
              if (executeResult.status === "halt") {
                return yield* new EnqueueHaltedError({
                  reason: executeResult.reason,
                });
              }

              invalidateStorageCache(
                executeResult.slot_writes.map((write) => write.slot),
              );

              yield* Queue.offer(enqueuedQueue, queued.index);
            }

            for (const block of unfinalizedBlocks.filter(
              (block) => block.number < message.block.number,
            )) {
              const nextStatus = nextBlockStatus(
                block,
                message.block.number,
                app.confirmations,
              );
              if (nextStatus === undefined) continue;

              block.status = nextStatus;

              for (const batch of block.batches) {
                batch.status = nextStatus;
                for (const mutation of batch.mutations) {
                  updateMutationToFinalized(mutation as IncludedMutation);
                }
              }

              yield* evm.pruneJournals({
                journal_ids: [
                  ...block.batches.flatMap((batch) =>
                    batch.mutations.map((mutation) => mutation.journalId),
                  ),
                  ...(forceExecutedJournalIds.get(block) ?? []),
                ],
              });
              forceExecutedJournalIds.delete(block);
              for (const batch of block.batches) {
                batchesById.delete(batch.id);
              }

              yield* emitBlock(block);

              for (const batch of block.batches) {
                yield* emitBatch(batchToEvent(batch));
                for (const mutation of batch.mutations) {
                  yield* emitMutation(mutationToEvent(mutation));
                }
              }
            }
            unfinalizedBlocks = unfinalizedBlocks.filter(
              (block) => block.status !== "finalized",
            );
          }),
        ),
      );
    });

    const submitIntervalMs = app.sequencing.submitIntervalMs;

    const batchProgram =
      app.sequencing.order === "batch"
        ? Effect.sleep(Duration.millis(app.sequencing.batchIntervalMs)).pipe(
            Effect.andThen(
              Effect.repeat(
                Queue.clear(receivedMutationQueue).pipe(
                  Effect.flatMap(acceptBatch),
                ),
                Schedule.fixed(Duration.millis(app.sequencing.batchIntervalMs)),
              ),
            ),
          )
        : Effect.forever(
            Queue.takeAll(receivedMutationQueue).pipe(
              Effect.flatMap(acceptBatch),
            ),
          );
    const submitProgram = Effect.sleep(Duration.millis(submitIntervalMs)).pipe(
      Effect.andThen(
        Effect.repeat(
          withSubmitLock(submit),
          Schedule.fixed(Duration.millis(submitIntervalMs)),
        ),
      ),
    );

    const persistProgram = Effect.forever(
      Effect.gen(function* () {
        const jobs = yield* Queue.takeAll(persistQueue);
        const persistStartedAt = yield* startTimer;
        yield* db.transaction((tx) =>
          Effect.forEach(jobs, ({ write }) => write(tx), { discard: true }),
        );
        for (const { committed } of jobs) {
          yield* Deferred.succeed(committed, undefined);
        }

        yield* Effect.logDebug("Persisted runtime writes").pipe(
          Effect.annotateLogs({
            job_count: jobs.length,
            duration: yield* durationMs(persistStartedAt),
          }),
        );
      }),
    );

    const program = Effect.all(
      [
        batchProgram,
        submitProgram,
        persistProgram,
        watchProgram,
        watch.program,
      ],
      { concurrency: "unbounded" },
    ).pipe(
      Effect.andThen(Effect.fail(new ProgramStoppedError())),
      Effect.raceFirst(lockLost),
      // Mutations waiting for the program would otherwise wait forever.
      Effect.onError((cause) =>
        Deferred.fail(stopped, new TypewriterStoppedError({ cause })),
      ),
    );

    function execute(
      mutation: RuntimeExecuteInput,
    ): Effect.Effect<TypewriterMutationResult, ExecuteError> {
      return Effect.gen(function* () {
        if (!isMutationName(mutation.name)) {
          return yield* new UnknownMutationError({ mutation: mutation.name });
        }

        const runtimeMutation = {
          name: mutation.name,
          params: mutation.params,
          authorization: mutation.authorization,
          status: "received",
          config: app.mutations[mutation.name]!,
        } as const satisfies ReceivedMutation;

        yield* Effect.logDebug("Received mutation").pipe(
          Effect.annotateLogs({
            mutation: runtimeMutation.name,
            params: runtimeMutation.params,
          }),
        );

        yield* emitMutation(mutationToEvent(runtimeMutation));

        yield* Schema.decodeUnknownEffect(
          executeInputSchemas.get(mutation.name)!,
        )(mutation).pipe(
          Effect.mapError(
            (cause) =>
              new EncodeMutationError({ mutation: runtimeMutation, cause }),
          ),
          Effect.tapError((error) =>
            emitMutation(
              mutationToEvent(
                updateMutationToRejected(runtimeMutation, { error }),
              ),
            ),
          ),
        );

        const deferred = yield* Deferred.make<
          { mutation: AcceptedMutation; committed: Deferred.Deferred<void> },
          ExecuteMutationError
        >();
        const acceptStartedAt = yield* startTimer;

        yield* Queue.offer(receivedMutationQueue, {
          mutation: runtimeMutation,
          deferred,
        });

        const acceptedMutation = yield* Effect.gen(function* () {
          const { mutation, committed } = yield* Deferred.await(deferred).pipe(
            // The caller gets the error, and a failure that stops the runtime is
            // logged when it stops, so a rejection is only a debug log.
            Effect.tapError((error) =>
              Effect.logDebug("Rejected mutation", error).pipe(
                Effect.annotateLogs({
                  mutation: runtimeMutation.name,
                  params: runtimeMutation.params,
                }),
              ),
            ),
          );
          yield* Deferred.await(committed);
          return mutation;
        }).pipe(Effect.raceFirst(Deferred.await(stopped)));

        yield* Effect.logDebug("Accepted mutation").pipe(
          Effect.annotateLogs({
            mutation: runtimeMutation.name,
            execution_index: acceptedMutation.executionIndex,
            duration: yield* durationMs(acceptStartedAt),
          }),
        );

        return { executionIndex: acceptedMutation.executionIndex };
      });
    }

    function on(
      event: "mutation",
      cb: MutationListener,
    ): Effect.Effect<() => void>;
    function on(event: "batch", cb: BatchListener): Effect.Effect<() => void>;
    function on(
      event: "block",
      cb: BlockListener<"fifo" | "batch">,
    ): Effect.Effect<() => void>;
    function on(
      event: "mutation" | "batch" | "block",
      cb: MutationListener | BatchListener | BlockListener<"fifo" | "batch">,
    ): Effect.Effect<() => void> {
      return Effect.sync(() => {
        if (event === "mutation") {
          const listener = cb as MutationListener;
          mutationListeners.add(listener);
          return () => mutationListeners.delete(listener);
        }
        if (event === "batch") {
          const listener = cb as BatchListener;
          batchListeners.add(listener);
          return () => batchListeners.delete(listener);
        }

        const listener = cb as BlockListener<"fifo" | "batch">;
        blockListeners.add(listener);
        return () => blockListeners.delete(listener);
      });
    }

    return {
      accounts,
      state,
      schema: app.mutationSchema,
      manifest: app.manifest,
      execute,
      on,
      program,
    } as TypewriterEffect<storageConfig, mutationsConfig, sequencingConfig>;
  });
}

export function nextBlockStatus(
  block: Pick<RuntimeBlock<"fifo" | "batch">, "number" | "status">,
  currentBlockNumber: bigint,
  confirmations: TypewriterApp["confirmations"],
): "finalized" | undefined {
  const blockDepth = currentBlockNumber - block.number;
  if (
    blockDepth >= BigInt(confirmations.finalizedBlockDepth) &&
    block.status !== "finalized"
  ) {
    return "finalized";
  }

  return undefined;
}
