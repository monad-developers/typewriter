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
import { deploymentLockKey, type MigrationError, migrate } from "./db-migrate";
import {
  deleteExecutionsFrom,
  deleteKeccakPreimages,
  insertKeccakPreimages,
  insertMutations,
  insertStorageSlots,
  selectKeccakPreimages,
  selectStorageSlots,
  updateMutationInclusion,
} from "./db-query";
import type { TypewriterMutationSchema } from "./db-schema";
import {
  decodeAuthorizationCalldata,
  decodeMutationCalldata,
  encodeBatchArg,
  encodeEnqueueCalldata,
  encodeExecuteCalldata,
} from "./encoding";
import { durationMs, startTimer } from "./logger";
import { Rpc, type RpcError } from "./rpc";
import {
  type BlockNotFoundError,
  type NoDataReturnedError,
  type RequestedBlock,
  requestBlock,
  requestExecutionIndex,
} from "./rpc-request";
import { TYPEWRITER_ABI } from "./typewriter-constants";
import type {
  AcceptedMutation,
  Authorization,
  BatchEvent,
  BatchListener,
  BlockEvent,
  BlockListener,
  EnqueuedMutation,
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

function resolveMutationConfig(app: TypewriterApp, name: string) {
  const config = app.mutations[name];
  return config === undefined ? undefined : { name, config };
}

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
  mutation: ReceivedMutation | EnqueuedMutation,
  params: {
    executionIndex: bigint;
    journalId: number;
  },
): AcceptedMutation {
  return updateMutation<ReceivedMutation | EnqueuedMutation, AcceptedMutation>(
    mutation,
    {
      status: "accepted",
      isForceInclusion: mutation.status === "enqueued",
      executionIndex: params.executionIndex,
      journalId: params.journalId,
    },
  );
}

export function updateMutationToRejected(
  mutation: ReceivedMutation | EnqueuedMutation,
  params: { error: ExecuteMutationError },
): RejectedMutation {
  return updateMutation<ReceivedMutation | EnqueuedMutation, RejectedMutation>(
    mutation,
    {
      status: "rejected",
      isForceInclusion: mutation.status === "enqueued",
      error: params.error,
    },
  );
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
    forceIncludedMutations: block.forceIncludedMutations.map(mutationToEvent),
  } as BlockEvent<"batch">;
}

export class EncodeMutationError extends Data.TaggedError(
  "EncodeMutationError",
)<{
  mutation: ReceivedMutation | EnqueuedMutation;
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
 * `config.expirationMarginS` of the latest block, so it could expire before
 * its settlement lands.
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

export function executeMutation(params: {
  app: TypewriterApp;
  evm: EVM;
  mutation: ReceivedMutation | EnqueuedMutation;
  /** The index the mutation takes if it executes. */
  executionIndex: bigint;
}): Effect.Effect<
  {
    mutation: AcceptedMutation;
    executeResult: ExecuteResult;
  },
  ExecuteMutationError
> {
  return Effect.gen(function* () {
    // TODO: Validate the fixed Authorization against the mirrored account
    // state before entering revm, then retain contract execution as the final
    // authority. The static wire shape makes this a future fast-rejection path.
    const mutationCalldata = yield* Effect.try({
      try: () =>
        params.mutation.status === "enqueued"
          ? encodeExecuteCalldata([], [params.mutation.queueIndex])
          : encodeExecuteCalldata([encodeBatchArg([params.mutation])], []),
      catch: (cause) =>
        new EncodeMutationError({ mutation: params.mutation, cause }),
    });

    const executeStartedAt = yield* startTimer;
    const executeResult = yield* params.evm.execute({
      from: params.app.account.address,
      to: params.app.address,
      data: mutationCalldata,
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

export function enqueueMutation(params: {
  app: TypewriterApp;
  evm: EVM;
  mutation: EnqueuedMutation;
}): Effect.Effect<ExecuteResult, EvmError> {
  return Effect.gen(function* () {
    const enqueueCalldata = encodeEnqueueCalldata(params.mutation);

    const executeResult = yield* params.evm.execute({
      from: "0x0000000000000000000000000000000000000000",
      to: params.app.address,
      data: enqueueCalldata,
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

export function decodeEnqueuedMutation(params: {
  app: TypewriterApp;
  log: LocalLog;
}): EnqueuedMutation {
  const forceInclusionLog = decodeEventLog({
    abi: TYPEWRITER_ABI,
    eventName: "ForceInclusionQueued",
    topics: params.log.topics,
    data: params.log.data,
    strict: true,
  }).args;

  const mutationEntry = Object.entries(params.app.mutations).find(
    ([_, mutationConfig]) => mutationConfig.id === forceInclusionLog.mutation,
  );
  if (mutationEntry === undefined) {
    throw new Error(
      `Unknown mutation ID ${forceInclusionLog.mutation} in ForceInclusionQueued event`,
    );
  }
  const [mutationName, mutationConfig] = mutationEntry;

  return {
    status: "enqueued",
    name: mutationName,
    config: mutationConfig,
    authorization: decodeAuthorizationCalldata(
      forceInclusionLog.authorizationData,
    ),
    isForceInclusion: true,
    queueIndex: forceInclusionLog.index,
    ...decodeMutationCalldata(mutationConfig, forceInclusionLog.mutationData),
  };
}

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
  const { batches, forceIncludedMutations, ...rest } = block;
  return {
    ...rest,
    mutations: [
      ...batches.flatMap((batch) => batch.mutations as IncludedMutation[]),
      ...forceIncludedMutations,
    ],
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
      deploymentLockKey(app.chainId, app.address),
      DEPLOYMENT_LOCK_TIMEOUT_MS,
    );

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
    /**
     * The preimages first seen by mutations that no settlement simulation has
     * included yet, so a rewind can forget them.
     */
    let unsubmittedPreimages: Hex.Hex[] = [];

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
    const receivedMutationQueue = yield* Queue.unbounded<{
      mutation: ReceivedMutation;
      deferred: AcceptDeferred;
    }>();
    const enqueuedMutationsQueue = yield* Queue.unbounded<EnqueuedMutation>();
    const acceptedBatchesQueue = yield* Queue.unbounded<{
      id: number;
      committed: Deferred.Deferred<void>;
    }>();
    const persistQueue = yield* Queue.unbounded<{
      write: (tx: DbTransaction) => Effect.Effect<void, DbError>;
      committed: Deferred.Deferred<void>;
    }>();
    yield* Scope.addFinalizer(scope, Queue.shutdown(receivedMutationQueue));
    yield* Scope.addFinalizer(scope, Queue.shutdown(enqueuedMutationsQueue));
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
      mutation: ReceivedMutation | EnqueuedMutation,
      minExpiration: bigint,
    ): Effect.Effect<void, MutationExpiresTooSoonError> {
      const { authorization } = mutation;
      const expirations = [authorization.expiration];
      if (mutation.name !== "CreateAccount") {
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
        if (authorization.credentialID < BigInt(credentials.length)) {
          expirations.push(
            BigInt(credentials[Number(authorization.credentialID)]!.expiration),
          );
        }
      }

      const expiration = expirations.find(
        (expiration) => expiration !== 0n && expiration < minExpiration,
      );
      return expiration === undefined
        ? Effect.void
        : Effect.fail(
            new MutationExpiresTooSoonError({ expiration, minExpiration }),
          );
    }

    // Executes a mutation against speculative state and updates in-memory
    // bookkeeping, but performs no database writes. Persistence is batched by
    // the caller (`acceptBatch`, `submit`, and `watch`) so many mutations share
    // a single set of insert statements.
    function acceptMutation(
      mutation: ReceivedMutation | EnqueuedMutation,
      /** Rejects the mutation if it expires before this timestamp. */
      minExpiration?: bigint,
    ): Effect.Effect<
      {
        mutation: AcceptedMutation;
        executeResult: ExecuteResult;
        /** Preimages first seen in this mutation, to persist. */
        preimages: readonly Hex.Hex[];
      },
      ExecuteMutationError
    > {
      return Effect.gen(function* () {
        const { executeResult, mutation: acceptedMutation } = yield* Effect.gen(
          function* () {
            if (minExpiration !== undefined) {
              yield* checkExpiration(mutation, minExpiration);
            }
            return yield* executeMutation({
              app,
              evm,
              mutation,
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

        invalidateStorageCache(
          executeResult.slot_writes.map((write) => write.slot),
        );

        const newPreimages: Hex.Hex[] = [];
        for (const preimage of executeResult.keccak_preimages) {
          if (preimages.has(preimage)) continue;
          preimages.add(preimage);
          newPreimages.push(preimage);
        }
        unsubmittedPreimages.push(...newPreimages);

        yield* emitMutation(mutationToEvent(acceptedMutation));

        return {
          mutation: acceptedMutation,
          executeResult,
          preimages: newPreimages,
        };
      });
    }

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

          const acceptedMutations: {
            mutation: AcceptedMutation;
            executeResult: ExecuteResult;
            preimages: readonly Hex.Hex[];
            deferred: AcceptDeferred;
          }[] = [];

          const minExpiration = blockTimestamp + BigInt(app.expirationMarginS);
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

    // Rewinds the speculative state to before the unsubmitted mutations, then
    // executes them again in the same order at the current block. A mutation
    // that fails now is dropped, and the ones after it take new execution
    // indexes. They are the newest journals, so reverting them restores the
    // state the earlier ones left. Enqueues since then only wrote new queue
    // entries, which these journals never touch.
    // TODO(kyle) `execute` already returned the old execution index, and a
    // dropped mutation goes from `accepted` to `rejected`.
    const reexecute = (
      batches: RuntimeBatch[],
      forceIncludedMutations: Extract<
        AcceptedMutation,
        { isForceInclusion: true }
      >[],
    ) =>
      Effect.gen(function* () {
        const pending = [
          ...batches.flatMap((batch) => batch.mutations as AcceptedMutation[]),
          ...forceIncludedMutations,
        ];
        yield* evm.revertJournals({
          journal_ids: pending.map((mutation) => mutation.journalId),
        });
        invalidateStorageCache();
        // A preimage that only a rewound mutation saw would otherwise
        // enumerate its mapping key, e.g. the nonce lane of a dropped mutation.
        const rewoundPreimages = unsubmittedPreimages;
        unsubmittedPreimages = [];
        for (const preimage of rewoundPreimages) preimages.delete(preimage);
        const fromExecutionIndex = pending[0]!.executionIndex;
        nextExecutionIndex = fromExecutionIndex;

        const executed: {
          mutation: AcceptedMutation;
          executeResult: ExecuteResult;
          preimages: readonly Hex.Hex[];
        }[] = [];
        const execute = (mutation: AcceptedMutation) =>
          Effect.gen(function* () {
            const { name, params, authorization, config } = mutation;
            const result = yield* Effect.result(
              acceptMutation(
                mutation.isForceInclusion
                  ? {
                      name,
                      params,
                      authorization,
                      config,
                      status: "enqueued",
                      isForceInclusion: true,
                      queueIndex: mutation.queueIndex,
                    }
                  : { name, params, authorization, config, status: "received" },
              ),
            );
            if (Result.isFailure(result)) return undefined;
            executed.push(result.success);
            return result.success.mutation;
          });

        const keptBatches: RuntimeBatch[] = [];
        for (const batch of batches) {
          const mutations: AcceptedMutation[] = [];
          for (const mutation of batch.mutations as AcceptedMutation[]) {
            const accepted = yield* execute(mutation);
            if (accepted !== undefined) mutations.push(accepted);
          }
          batch.mutations = mutations;
          if (mutations.length > 0) keptBatches.push(batch);
          else batchesById.delete(batch.id);
        }
        const keptForceIncludedMutations: typeof forceIncludedMutations = [];
        for (const mutation of forceIncludedMutations) {
          const accepted = yield* execute(mutation);
          if (accepted !== undefined) {
            keptForceIncludedMutations.push(
              accepted as (typeof forceIncludedMutations)[number],
            );
          }
        }

        const committed = yield* persist((tx) =>
          Effect.gen(function* () {
            yield* deleteExecutionsFrom(
              tx,
              app.mutationSchema,
              app.typewriterSchema,
              fromExecutionIndex,
            );
            yield* deleteKeccakPreimages(
              tx,
              app.typewriterSchema,
              rewoundPreimages,
            );
            yield* insertMutations(
              tx,
              app.mutationSchema,
              executed.map((entry) => entry.mutation),
            );
            yield* insertStorageSlots(tx, app.typewriterSchema, executed);
            yield* insertKeccakPreimages(
              tx,
              app.typewriterSchema,
              executed.flatMap(({ preimages }) => preimages),
            );
          }),
        );

        return {
          batches: keptBatches,
          forceIncludedMutations: keptForceIncludedMutations,
          committed,
          droppedCount: pending.length - executed.length,
        };
      });

    const submit = Effect.gen(function* () {
      const simulation = yield* withSpeculativeStateLock(
        Effect.gen(function* () {
          const acceptedBatches = yield* Queue.clear(acceptedBatchesQueue);
          const enqueuedMutations = yield* Queue.clear(enqueuedMutationsQueue);
          if (acceptedBatches.length === 0 && enqueuedMutations.length === 0) {
            return undefined;
          }

          let batches = acceptedBatches.map(({ id }) => batchesById.get(id)!);
          const commits = acceptedBatches.map(({ committed }) => committed);

          const acceptedEnqueuedMutations: {
            mutation: Extract<AcceptedMutation, { isForceInclusion: true }>;
            executeResult: ExecuteResult;
            preimages: readonly Hex.Hex[];
          }[] = [];
          for (const enqueuedMutation of enqueuedMutations) {
            const result = yield* Effect.result(
              acceptMutation(enqueuedMutation),
            );
            if (Result.isSuccess(result)) {
              acceptedEnqueuedMutations.push(
                result.success as {
                  mutation: Extract<
                    AcceptedMutation,
                    { isForceInclusion: true }
                  >;
                  executeResult: ExecuteResult;
                  preimages: readonly Hex.Hex[];
                },
              );
            } else {
              // No caller gets this error, and the runtime keeps running.
              yield* Effect.logWarning(
                "Discarded enqueued mutation",
                result.failure,
              ).pipe(
                Effect.annotateLogs({
                  mutation: enqueuedMutation.name,
                  queue_index: enqueuedMutation.queueIndex,
                }),
              );
              // TODO(kyle) how to handle failed enqueue.
              // TODO(kyle) the discarded mutation stays in the queue onchain,
              // and anyone can `forceExecute` it after FORCE_INCLUSION_DELAY.
              // It can succeed then, for example once its nonce is next, and
              // change state and `executionIndex` outside revm. The watch only
              // sees `ForceInclusionQueued` logs and `forceExecute` emits no
              // event, so revm would not see it.
            }
          }

          let acceptedForceIncludedMutations = acceptedEnqueuedMutations.map(
            ({ mutation }) => mutation,
          );

          if (
            batches.length === 0 &&
            acceptedForceIncludedMutations.length === 0
          ) {
            return undefined;
          }

          if (acceptedEnqueuedMutations.length > 0) {
            commits.push(
              yield* persist((tx) =>
                Effect.gen(function* () {
                  yield* insertMutations(
                    tx,
                    app.mutationSchema,
                    acceptedEnqueuedMutations.map((entry) => entry.mutation),
                  );
                  yield* insertStorageSlots(
                    tx,
                    app.typewriterSchema,
                    acceptedEnqueuedMutations,
                  );
                  yield* insertKeccakPreimages(
                    tx,
                    app.typewriterSchema,
                    acceptedEnqueuedMutations.flatMap(
                      ({ preimages }) => preimages,
                    ),
                  );
                }),
              ),
            );
          }

          while (true) {
            const speculativeJournalIds = batches
              .flatMap((batch) => batch.mutations)
              .map((mutation) => mutation.journalId)
              .concat(
                acceptedForceIncludedMutations.map(
                  (mutation) => mutation.journalId,
                ),
              );

            // TODO(kyle) cap a submission at the block gas limit. Every pending
            // batch and enqueued mutation goes into one transaction, so after a
            // backlog the node rejects it ("intrinsic gas too high") and the
            // retries fail the program.
            const calldata = encodeExecuteCalldata(
              batches.map((batch) => encodeBatchArg(batch.mutations)),
              acceptedForceIncludedMutations.map(
                ({ queueIndex }) => queueIndex,
              ),
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
            if (simulateResult.status === "revert") {
              const error = new SettlementSimulationRevertedError(
                decodeRevert(app.abi, simulateResult.data),
              );
              // Each mutation executed when it was accepted, so the settlement
              // reverts when one fails in a later block, e.g. on an
              // authorization that expired since. Execute them again, in
              // order, and drop the ones that fail.
              const reexecuted = yield* reexecute(
                batches,
                acceptedForceIncludedMutations,
              );
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
              acceptedForceIncludedMutations =
                reexecuted.forceIncludedMutations;
              commits.push(reexecuted.committed);
              if (
                batches.length === 0 &&
                acceptedForceIncludedMutations.length === 0
              ) {
                return undefined;
              }
              continue;
            }

            yield* Effect.logDebug("Simulated settlement transaction").pipe(
              Effect.annotateLogs({
                nonce,
                gas_limit: simulateResult.gas_limit,
                batch_count: batches.length,
                mutation_count: speculativeJournalIds.length,
                duration,
              }),
            );

            unsubmittedPreimages = [];
            return {
              batches,
              acceptedForceIncludedMutations,
              calldata,
              simulateResult,
              commits,
            };
          }
        }),
      );

      if (simulation === undefined) return;

      const {
        batches,
        acceptedForceIncludedMutations,
        calldata,
        simulateResult,
        commits,
      } = simulation;

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

      const forceIncludedMutations = acceptedForceIncludedMutations.map(
        (mutation) => updateMutationToIncluded(mutation, inclusion),
      );

      const runtimeBlock: RuntimeBlock<"batch"> = {
        status: "included",
        number: block.number,
        hash: block.hash,
        timestamp: block.timestamp,
        transactionHash: receipt.transactionHash,
        batches,
        forceIncludedMutations,
      };

      yield* persist((tx) =>
        updateMutationInclusion(
          tx,
          app.mutationSchema,
          [
            ...batches.flatMap((batch) => batch.mutations),
            ...forceIncludedMutations,
          ],
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
      for (const mutation of forceIncludedMutations) {
        yield* emitMutation(mutationToEvent(mutation));
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
              const enqueuedMutation = decodeEnqueuedMutation({ app, log });

              const executeResult = yield* withSpeculativeStateLock(
                enqueueMutation({ app, evm, mutation: enqueuedMutation }),
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

              yield* Queue.offer(enqueuedMutationsQueue, enqueuedMutation);
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
              for (const mutation of block.forceIncludedMutations) {
                updateMutationToFinalized(mutation);
              }

              const submittedMutations = [
                ...block.batches.flatMap(
                  (batch) => batch.mutations as IncludedMutation[],
                ),
                ...block.forceIncludedMutations,
              ];

              yield* evm.pruneJournals({
                journal_ids: submittedMutations.map(
                  (mutation) => mutation.journalId,
                ),
              });
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
              for (const mutation of block.forceIncludedMutations) {
                yield* emitMutation(mutationToEvent(mutation));
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
        const resolvedMutation = resolveMutationConfig(app, mutation.name);
        if (resolvedMutation === undefined) {
          return yield* new UnknownMutationError({ mutation: mutation.name });
        }

        const runtimeMutation = {
          name: resolvedMutation.name,
          params: mutation.params,
          authorization: mutation.authorization,
          status: "received",
          config: resolvedMutation.config,
        } as const satisfies ReceivedMutation;

        yield* Effect.logDebug("Received mutation").pipe(
          Effect.annotateLogs({
            mutation: runtimeMutation.name,
            params: runtimeMutation.params,
          }),
        );

        yield* emitMutation(mutationToEvent(runtimeMutation));

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
