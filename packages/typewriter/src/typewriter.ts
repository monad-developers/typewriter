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
import { Database, type Db } from "./db";
import {
  deploymentLockKey,
  dropSchema,
  type MigrationError,
  migrate,
} from "./db-migrate";
import {
  accountStorage,
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
  type CompiledStatement,
  compile,
  type DbError,
  type DbStatement,
} from "./db-transport";
import {
  EMPTY_BATCH,
  encodeBatchArg,
  encodeEnqueueCalldata,
  encodeExecuteCalldata,
} from "./encoding";
import { durationMs, startTimer } from "./logger";
import { executeInputSchema, mutationNameGuard } from "./mutation-schema";
import { Rpc, type RpcError } from "./rpc";
import {
  type NoDataReturnedError,
  requestBlock,
  requestExecutionHash,
  requestExecutionIndex,
} from "./rpc-request";
import {
  EXPIRATION_MARGIN,
  TX_GAS_LIMIT_CAP,
  TYPEWRITER_ABI,
} from "./typewriter-constants";
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
  type LocalBlock,
  type LocalLog,
  type WatchError,
  watchChain,
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

/** How many blocks a pending settlement waits before it is sent again. The lowest, which the rest wait on, waits one. */
const REBROADCAST_BLOCKS = 3n;

/**
 * How many blocks a settlement can go without landing after it is first sent.
 * Counted in blocks, so a paused process doesn't count as a stuck settlement.
 */
const STUCK_BLOCKS = 300n;

/** The intrinsic gas of a transaction, which every settlement pays once. */
const TRANSACTION_BASE_GAS = 21_000;

/** What an access list charges for each address it names. */
const ACCESS_LIST_ADDRESS_GAS = 2_400;

/** The gas an SSTORE needs left, which a gas limit must leave. */
const SSTORE_SENTRY_GAS = 2_300;

/**
 * Groups `items` in order so each group's gas stays under `gasCap`. An item
 * over the cap on its own gets a group of its own.
 *
 * @dev Settlements are not capped in bytes.
 */
function chunkByGas<item>(
  items: readonly item[],
  gasCap: number,
  gasOf: (item: item) => number,
): item[][] {
  const groups: item[][] = [];
  let gas = 0;
  for (const item of items) {
    gas += gasOf(item);
    if (groups.length === 0 || gas > gasCap) {
      groups.push([]);
      gas = gasOf(item);
    }
    groups.at(-1)!.push(item);
  }
  return groups;
}

type AccessList = { address: Hex.Hex; storageKeys: Hex.Hex[] }[];

const WATCH_BUFFER_SIZE = 16;

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

/**
 * After a resync, the chain's `executionHash` is not where the first reverted
 * settlement started, so something outside the runtime executed.
 */
export class ResyncMismatchError extends Data.TaggedError(
  "ResyncMismatchError",
)<{
  blockNumber: bigint;
  expected: Hex.Hex;
  actual: Hex.Hex;
}> {
  override get message() {
    return `At block ${this.blockNumber}, the execution hash is ${this.actual}, but the reverted settlements start at ${this.expected}`;
  }
}

/**
 * A settlement succeeded after an earlier one reverted. Each checks the
 * execution hash, so only an execution outside the runtime allows it.
 */
export class SettlementAfterRevertError extends Data.TaggedError(
  "SettlementAfterRevertError",
)<{
  transactionHash: Hex.Hex;
}> {
  override get message() {
    return `Settlement transaction ${this.transactionHash} succeeded after an earlier one reverted`;
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

/** A settlement did not land {@link STUCK_BLOCKS} blocks after it was first sent. */
export class SettlementStuckError extends Data.TaggedError(
  "SettlementStuckError",
)<{
  nonce: number;
  transactionHash: Hex.Hex;
}> {
  override get message() {
    return `Settlement transaction ${this.transactionHash} with nonce ${this.nonce} did not land ${STUCK_BLOCKS} blocks after it was sent`;
  }
}

/** A node rejected a settlement for a reason that sending it again can't fix. */
export class SettlementRejectedError extends Data.TaggedError(
  "SettlementRejectedError",
)<{
  nonce: number;
  transactionHash: Hex.Hex;
  reason: string;
}> {
  override get message() {
    return `Settlement transaction ${this.transactionHash} with nonce ${this.nonce} was rejected: ${this.reason}`;
  }
}

/** The scheduler has pending transactions at startup, e.g. from a previous process. */
export class PendingTransactionsError extends Data.TaggedError(
  "PendingTransactionsError",
)<{
  address: Hex.Hex;
  latest: number;
  pending: number;
}> {
  override get message() {
    return `Account ${this.address} has ${this.pending - this.latest} pending transactions`;
  }
}

/**
 * A reorg replaced a block with settlements before it was final. The runtime
 * does not follow a settlement to its new block.
 */
export class SettlementReorgedError extends Data.TaggedError(
  "SettlementReorgedError",
)<{
  blockNumber: bigint;
  blockHash: Hex.Hex;
}> {
  override get message() {
    return `Settlements were reorged out of block ${this.blockNumber} (${this.blockHash})`;
  }
}

/**
 * A reorg replaced a block with enqueues that revm replayed. The runtime does
 * not undo an enqueue.
 */
export class EnqueueReorgedError extends Data.TaggedError(
  "EnqueueReorgedError",
)<{
  blockNumber: bigint;
  blockHash: Hex.Hex;
}> {
  override get message() {
    return `Block ${this.blockNumber} (${this.blockHash}) with enqueued mutations was reorged out`;
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
  | SettlementRevertedError
  | ResyncMismatchError
  | SettlementAfterRevertError
  | SettlementReorgedError
  | SettlementStuckError
  | EnqueueRevertedError
  | EnqueueHaltedError
  | EnqueueReorgedError
  | SignTransactionError
  | ProgramStoppedError;

export type CreateTypewriterError =
  | DbError
  | RpcError
  | NoDataReturnedError
  | MigrationError
  | ChainIdMismatchError
  | PendingTransactionsError
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
  params: Pick<AcceptedMutation, "executionIndex" | "journalId" | "gas">,
): AcceptedMutation {
  return updateMutation<ReceivedMutation, AcceptedMutation>(mutation, {
    status: "accepted",
    ...params,
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
    gas: _gas,
    ...event
  } = mutation as RuntimeMutation & {
    journalId?: number;
    gas?: number;
  };
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

/** A mutation takes more gas than a settlement can. */
export class MutationTooLargeError extends Data.TaggedError(
  "MutationTooLargeError",
)<{
  gas: number;
}> {
  override get message() {
    return `Mutation takes ${this.gas} gas, more than a settlement can`;
  }
}

export type ExecuteMutationError =
  | EncodeMutationError
  | EvmError
  | MutationRevertedError
  | MutationHaltedError
  | MutationExpiresTooSoonError
  | MutationTooLargeError;

/** The `execute` calldata of `mutation`. Fails if a field is malformed. */
export function encodeMutation(
  mutation: ReceivedMutation,
  fromExecutionHash: Hex.Hex,
  timestamp: bigint,
): Effect.Effect<Hex.Hex, EncodeMutationError> {
  return Effect.try({
    try: () =>
      encodeExecuteCalldata(
        fromExecutionHash,
        timestamp,
        encodeBatchArg([mutation]),
        [],
      ),
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
  /** The gas of a settlement with nothing in it. */
  settlementOverhead: number;
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
      gas: executeResult.gas_used - params.settlementOverhead,
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
    const [preimageRows, storageRows] = yield* db.run([
      selectKeccakPreimages(app.typewriterSchema),
      selectStorageSlots(app.typewriterSchema),
    ]);
    const preimages = new Set(preimageRows.map((row) => row.preimage));
    const initialAccountStorage = accountStorage(storageRows);

    if (code === "0x") {
      yield* Effect.logWarning(
        "Detected no contract code at the typewriter address; mutations will execute without it",
      ).pipe(Effect.annotateLogs({ address: app.address }));
    }
    const evm = yield* createEVM({
      spec: app.hardfork,
      chain_id: app.chainId,
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

    yield* rpc.requestEach({
      method: "eth_getBlockByNumber",
      params: ["finalized", false],
    });

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
      yield* createRuntimeState(app, db, code);

    yield* evm.setBlockContext({
      number: Hex.fromNumber(startBlock.number),
      timestamp: Hex.fromNumber(startBlock.timestamp),
    });

    let blockContext = {
      number: startBlock.number,
      timestamp: startBlock.timestamp,
    };
    /** The timestamp each batch executed at, which its settlement pins. */
    const timestampOf = new WeakMap<RuntimeBatch, bigint>();
    /** The `executionHash` an execution starts from, and the slots it touched. */
    const executionOf = new WeakMap<
      { executionIndex: bigint },
      { fromExecutionHash: Hex.Hex; accessList: AccessList }
    >();
    const forceJournalIds = new WeakMap<{ executionIndex: bigint }, number>();
    const executionHashSlot = Hex.padLeft(
      Hex.fromNumber(
        BigInt(
          app.storageLayout.storage.find(
            ({ label }) => label === "executionHash",
          )!.slot,
        ),
      ),
      32,
    );
    const readExecutionHash = evm
      .readStorage({ address: app.address, slots: [executionHashSlot] })
      .pipe(Effect.map((values) => Hex.padLeft(Object.values(values)[0]!, 32)));
    // A mutation's gas in revm, less this, bounds the gas it adds to a
    // settlement: alone, it paid for every slot cold.
    const settlementOverhead = yield* evm
      .execute({
        from: app.account.address,
        to: app.address,
        data: encodeExecuteCalldata(
          yield* readExecutionHash,
          startBlock.timestamp,
          EMPTY_BATCH,
          [],
        ),
      })
      .pipe(
        Effect.flatMap((result) =>
          result.status === "success"
            ? evm
                .pruneJournals({ journal_ids: [result.journal_id] })
                .pipe(Effect.as(result.gas_used))
            : Effect.succeed(TRANSACTION_BASE_GAS),
        ),
      );
    /** The most gas the executions of one settlement can add. */
    const settlementGas =
      TX_GAS_LIMIT_CAP - Math.ceil(TX_GAS_LIMIT_CAP / 32) - settlementOverhead;

    let batchId = 0;
    let batchPosition = 0;

    const batchesById = new Map<number, RuntimeBatch>();
    const isMutationName = mutationNameGuard(Object.keys(app.mutations));
    const executeInputSchemas = new Map(
      Object.entries(app.mutations).map(([name, config]) => [
        name,
        executeInputSchema(config.params),
      ]),
    );
    const forceExecutedJournalIds = new Map<RuntimeBlock<"batch">, number[]>();
    const receivedMutationQueue = yield* Queue.unbounded<{
      mutation: ReceivedMutation;
      deferred: AcceptDeferred;
    }>();
    const enqueuedQueue = yield* Queue.unbounded<bigint>();
    const acceptedBatchesQueue = yield* Queue.unbounded<{
      id: number;
      committed: Deferred.Deferred<void>;
    }>();
    const persistQueue = yield* Queue.unbounded<{
      statements: CompiledStatement[];
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
    const submitSignal = yield* Queue.sliding<void>(1);
    yield* Scope.addFinalizer(scope, Queue.shutdown(submitSignal));

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

    const transactionCount = (tag: "latest" | "pending") =>
      rpc
        .request({
          method: "eth_getTransactionCount",
          params: [app.account.address, tag],
        })
        .pipe(Effect.map(Hex.toNumber));
    let nonce = yield* transactionCount("latest");
    const pendingCount = yield* transactionCount("pending");
    if (pendingCount > nonce) {
      return yield* new PendingTransactionsError({
        address: app.account.address,
        latest: nonce,
        pending: pendingCount,
      });
    }

    let unfinalizedBlocks: RuntimeBlock<"batch">[] = [];
    const mutationListeners = new Set<MutationListener>();
    const batchListeners = new Set<BatchListener>();
    const blockListeners = new Set<BlockListener<"fifo" | "batch">>();

    const emit = <event>(
      name: "mutation" | "batch" | "block",
      listeners: ReadonlySet<(event: event) => void>,
      event: event,
      copy: (event: event) => event = structuredClone,
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
                const result: unknown = cb(copy(event));
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
      emit("mutation", mutationListeners, event, (event) => {
        if (event.status !== "rejected") return structuredClone(event);
        const { error, ...rest } = event;
        return { ...structuredClone(rest), error };
      });

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

    function acceptMutation(
      mutation: ReceivedMutation,
      /** The timestamp it executes at, which its settlement pins. */
      timestamp: bigint,
      /** Rejects the mutation if a settlement of it takes more gas. */
      maxGas = settlementGas,
    ): Effect.Effect<AcceptedExecution, ExecuteMutationError> {
      return Effect.gen(function* () {
        const { executeResult, mutation: acceptedMutation } = yield* Effect.gen(
          function* () {
            const fromExecutionHash = yield* readExecutionHash;
            const calldata = yield* encodeMutation(
              mutation,
              fromExecutionHash,
              timestamp,
            );
            yield* checkExpiration(
              mutation,
              timestamp + BigInt(EXPIRATION_MARGIN),
            );
            // TODO: Validate the fixed Authorization against the mirrored
            // account state before entering revm, then retain contract
            // execution as the final authority. The static wire shape makes
            // this a future fast-rejection path.
            const executed = yield* executeMutation({
              app,
              evm,
              mutation,
              calldata,
              executionIndex: nextExecutionIndex,
              settlementOverhead,
            });
            const { gas } = executed.mutation;
            if (gas > maxGas) {
              yield* evm.revertJournals({
                journal_ids: [executed.mutation.journalId],
              });
              invalidateStorageCache(
                executed.executeResult.slot_writes.map((write) => write.slot),
              );
              return yield* new MutationTooLargeError({ gas });
            }
            executionOf.set(executed.mutation, {
              fromExecutionHash,
              accessList: executed.executeResult.access_list,
            });
            return executed;
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

    function forceExecute(queueIndex: bigint, timestamp: bigint) {
      return Effect.gen(function* () {
        const fromExecutionHash = yield* readExecutionHash;
        const executeResult = yield* evm.execute({
          from: app.account.address,
          to: app.address,
          data: encodeExecuteCalldata(
            fromExecutionHash,
            timestamp,
            EMPTY_BATCH,
            [queueIndex],
          ),
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

        const gas = executeResult.gas_used - settlementOverhead;
        if (gas > settlementGas) {
          yield* evm.revertJournals({
            journal_ids: [executeResult.journal_id],
          });
          invalidateStorageCache(
            executeResult.slot_writes.map((write) => write.slot),
          );
          yield* Effect.logWarning(
            "Discarded enqueued mutation, which takes more gas than a settlement can",
          ).pipe(Effect.annotateLogs({ queue_index: queueIndex, gas }));
          return undefined;
        }

        const executionIndex = nextExecutionIndex++;
        const mutation = { executionIndex };
        executionOf.set(mutation, {
          fromExecutionHash,
          accessList: executeResult.access_list,
        });
        forceJournalIds.set(mutation, executeResult.journal_id);
        yield* Effect.logDebug("Force-executed enqueued mutation").pipe(
          Effect.annotateLogs({
            queue_index: queueIndex,
            execution_index: executionIndex,
          }),
        );
        return {
          queueIndex,
          mutation,
          timestamp,
          gas,
          executeResult,
          preimages: recordExecution(executeResult),
        };
      });
    }

    type ForceExecution = NonNullable<
      Effect.Success<ReturnType<typeof forceExecute>>
    >;

    const persist = (statements: DbStatement<unknown>[]) => {
      const compiled = statements.map(compile);
      return Effect.gen(function* () {
        const committed = yield* Deferred.make<void>();
        yield* Queue.offer(persistQueue, { statements: compiled, committed });
        return committed;
      });
    };

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

          const { timestamp } = blockContext;
          for (const { mutation, deferred } of submittedMutations) {
            const result = yield* Effect.result(
              acceptMutation(mutation, timestamp),
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

          const batches = chunkByGas(
            acceptedMutations.map(({ mutation }) => mutation),
            settlementGas,
            (mutation) => mutation.gas,
          ).map(
            (mutations): RuntimeBatch => ({
              status: "accepted",
              id: batchId++,
              position: batchPosition++,
              mutations,
            }),
          );

          for (const batch of batches) {
            yield* Effect.logDebug("Created batch").pipe(
              Effect.annotateLogs({
                batch_id: batch.id,
                mutation_count: batch.mutations.length,
                duration: yield* durationMs(batchStartedAt),
              }),
            );
            batchesById.set(batch.id, batch);
            timestampOf.set(batch, timestamp);
            yield* emitBatch(batchToEvent(batch));
          }

          const last = batches.at(-1)!;
          planOf.set(last, yield* price(batchSettlement(last)));

          const committed = yield* persist([
            ...insertMutations(
              app.mutationSchema,
              acceptedMutations.map((entry) => entry.mutation),
            ),
            ...insertStorageSlots(app.typewriterSchema, acceptedMutations),
            ...insertKeccakPreimages(
              app.typewriterSchema,
              acceptedMutations.flatMap(({ preimages }) => preimages),
            ),
          ]);
          for (const batch of batches) {
            yield* Queue.offer(acceptedBatchesQueue, {
              id: batch.id,
              committed,
            });
          }
          yield* Queue.offer(submitSignal, undefined);
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
      queueIndexes: bigint[],
    ) =>
      Effect.gen(function* () {
        // After an onchain revert, later batches executed after its enqueues.
        const pending = [
          ...batches.flatMap((batch) => batch.mutations as AcceptedMutation[]),
          ...forceExecuted.map(({ mutation, executeResult }) => ({
            executionIndex: mutation.executionIndex,
            journalId: executeResult.journal_id,
          })),
        ].sort((a, b) => Number(a.executionIndex - b.executionIndex));
        const fromExecutionIndex = pending[0]!.executionIndex;
        yield* evm.revertJournals({
          journal_ids: pending.map(({ journalId }) => journalId),
        });
        invalidateStorageCache();
        nextExecutionIndex = fromExecutionIndex;
        // They execute again in the current block, so a settlement of them pins it.
        const { timestamp } = blockContext;

        const executed: AcceptedExecution[] = [];
        for (const batch of batches) {
          timestampOf.set(batch, timestamp);
          const kept: AcceptedMutation[] = [];
          // Gas depends on state, so a batch can outgrow a settlement now.
          let batchGas = 0;
          for (const mutation of batch.mutations as AcceptedMutation[]) {
            const result = yield* Effect.result(
              acceptMutation(
                toUnexecuted(mutation),
                timestamp,
                settlementGas - batchGas,
              ),
            );
            if (Result.isFailure(result)) continue;
            executed.push(result.success);
            kept.push(result.success.mutation);
            batchGas += result.success.mutation.gas;
          }
          batch.mutations = kept;
          if (batch.mutations.length === 0) {
            batchesById.delete(batch.id);
          } else {
            planOf.set(batch, yield* price(batchSettlement(batch)));
          }
        }
        // An enqueue that failed before can execute once a dropped mutation
        // frees what it held, such as a nonce.
        const keptForceExecuted: ForceExecution[] = [];
        for (const queueIndex of queueIndexes) {
          const reexecuted = yield* forceExecute(queueIndex, timestamp);
          if (reexecuted !== undefined) keptForceExecuted.push(reexecuted);
        }

        const committed = yield* persist([
          ...deleteExecutionsFrom(
            app.mutationSchema,
            app.typewriterSchema,
            fromExecutionIndex,
          ),
          ...insertMutations(
            app.mutationSchema,
            executed.map((entry) => entry.mutation),
          ),
          ...insertStorageSlots(app.typewriterSchema, [
            ...executed,
            ...keptForceExecuted,
          ]),
          ...insertKeccakPreimages(
            app.typewriterSchema,
            [...executed, ...keptForceExecuted].flatMap(
              ({ preimages }) => preimages,
            ),
          ),
        ]);

        const kept = new Set(
          keptForceExecuted.map(({ queueIndex }) => queueIndex),
        );
        const droppedCount =
          pending.length -
          executed.length -
          forceExecuted.filter(({ queueIndex }) => kept.has(queueIndex)).length;
        yield* Effect.logWarning("Executed mutations again").pipe(
          Effect.annotateLogs({
            dropped_count: droppedCount,
            mutation_count: pending.length,
          }),
        );

        return {
          batches: batches.filter((batch) => batch.mutations.length > 0),
          forceExecuted: keptForceExecuted,
          committed,
        };
      });

    type RevertedSettlement = {
      batches: RuntimeBatch[];
      forceExecuted: ForceExecution[];
      queueIndexes: bigint[];
    };

    /** One settlement transaction: one batch, or the enqueues it force-executes. */
    type Settlement = {
      timestamp: bigint;
      batch: RuntimeBatch | undefined;
      forceExecuted: ForceExecution[];
      /** Its gas limit and access list, from revm, once it is priced. */
      plan?: Plan;
      /** Enqueues that failed in revm when it was packed, to try again after a revert. */
      discardedQueueIndexes: bigint[];
    };

    /** A settlement given a nonce, until its block is final. */
    type Submitted = {
      settlement: Settlement;
      nonce: number;
      /** Set once it is signed. */
      hash?: Hex.Hex;
      raw?: Hex.Hex;
      gasLimit: number;
      /** The block number when it was last broadcast. */
      sentAt: bigint;
      /** The block number when it was first broadcast. */
      firstSentAt?: bigint;
      status: "pending" | "included" | "reverted";
      /** The block it landed in. */
      block?: { number: bigint; hash: Hex.Hex; timestamp: bigint };
    };

    /** By nonce, in nonce order. */
    const submitted = new Map<number, Submitted>();
    /** The settlements of an onchain revert, which `settle` executes again first. */
    let reverted: RevertedSettlement | undefined;
    /**
     * Set from an onchain revert until every settlement sent before it lands.
     * Each checks the execution hash, so every later one reverts too.
     * Nothing is sent until then.
     */
    let resync: Submitted[] | undefined;

    const journalIdOf = (execution: { executionIndex: bigint }) =>
      "journalId" in execution
        ? (execution as AcceptedMutation).journalId
        : forceJournalIds.get(execution);
    const executionsOf = (settlement: Settlement) => [
      ...(settlement.batch?.mutations ?? []),
      ...settlement.forceExecuted.map(({ mutation }) => mutation),
    ];
    const fromExecutionHashOfSettlement = (settlement: Settlement) =>
      executionOf.get(executionsOf(settlement)[0]!)!.fromExecutionHash;

    // Every slot an execution touched, so the settlement pays for each once.
    const accessListOf = (settlement: Settlement): AccessList => {
      const slots = new Map<Hex.Hex, Set<Hex.Hex>>();
      for (const execution of executionsOf(settlement)) {
        for (const { address, storageKeys } of executionOf.get(execution)!
          .accessList) {
          const keys = slots.get(address) ?? new Set();
          for (const key of storageKeys) keys.add(key);
          slots.set(address, keys);
        }
      }
      return [...slots].map(([address, keys]) => ({
        address,
        storageKeys: [...keys].sort(),
      }));
    };

    type Plan = { gasLimit: number; accessList: AccessList };
    const planOf = new WeakMap<RuntimeBatch, Plan>();

    const calldataOf = (settlement: Settlement) =>
      encodeExecuteCalldata(
        fromExecutionHashOfSettlement(settlement),
        settlement.timestamp,
        settlement.batch === undefined
          ? EMPTY_BATCH
          : encodeBatchArg(settlement.batch.mutations),
        settlement.forceExecuted.map(({ queueIndex }) => queueIndex),
      );

    // Each execution's gas alone bounds what it adds to the settlement, and
    // the call reserve and SSTORE sentry leave room the chain requires.
    const boundedPlan = (settlement: Settlement): Plan => {
      const accessList = accessListOf(settlement);
      return { accessList, gasLimit: gasLimitOf(settlement, accessList) };
    };

    // Simulates the settlement in revm while its executions are the newest
    // journals, so its gas counts the slots they share. Falls back to the bound.
    const price = (settlement: Settlement) =>
      evm
        .simulate({
          from: app.account.address,
          to: app.address,
          data: calldataOf(settlement),
          journal_ids: executionsOf(settlement).map(
            (execution) => journalIdOf(execution)!,
          ),
        })
        .pipe(
          Effect.map(
            (result): Plan =>
              result.status === "success"
                ? { gasLimit: result.gas_limit, accessList: result.access_list }
                : boundedPlan(settlement),
          ),
        );

    const batchSettlement = (batch: RuntimeBatch): Settlement => ({
      timestamp: timestampOf.get(batch)!,
      batch,
      forceExecuted: [],
      discardedQueueIndexes: [],
      plan: planOf.get(batch),
    });

    const gasLimitOf = (settlement: Settlement, accessList: AccessList) => {
      const gas =
        settlementOverhead +
        ACCESS_LIST_ADDRESS_GAS * accessList.length +
        (settlement.batch?.mutations ?? []).reduce(
          (sum, mutation) => sum + mutation.gas,
          0,
        ) +
        settlement.forceExecuted.reduce((sum, { gas }) => sum + gas, 0);
      return gas + Math.ceil(gas / 64) + SSTORE_SENTRY_GAS;
    };

    // Each batch settles in its own transaction, and the enqueues after them.
    const toSettlements = (
      batches: RuntimeBatch[],
      forceExecuted: ForceExecution[],
    ): Settlement[] => [
      ...batches.map(batchSettlement),
      ...chunkByGas(forceExecuted, settlementGas, ({ gas }) => gas).map(
        (executions) => ({
          timestamp: executions[0]!.timestamp,
          batch: undefined,
          forceExecuted: executions,
          discardedQueueIndexes: [],
        }),
      ),
    ];

    const sign = (
      calldata: Hex.Hex,
      gasLimit: number,
      accessList: AccessList,
      nonce: number,
    ) =>
      Effect.gen(function* () {
        const filled = yield* rpc.request({
          method: "eth_fillTransaction",
          params: [
            {
              from: app.account.address,
              to: app.address,
              data: calldata,
              gas: Hex.fromNumber(gasLimit),
              nonce: Hex.fromNumber(nonce),
              accessList,
            },
          ],
        });

        // `eth_fillTransaction` returns an already-signed `raw`; strip its
        // signature fields so the account re-signs over the correct payload.
        const transaction = parseTransaction(filled.raw);
        delete transaction.r;
        delete transaction.s;
        delete transaction.v;
        delete transaction.yParity;
        const signed = yield* Effect.tryPromise({
          try: () => app.account.signTransaction(transaction),
          catch: (cause) => new SignTransactionError({ cause }),
        });
        return signed as Hex.Hex;
      });

    // Sends to every node, and is sent again until it lands, so a node that
    // fails or answers wrongly costs nothing.
    const broadcast = (entry: Submitted) =>
      Effect.gen(function* () {
        entry.sentAt = blockContext.number;
        entry.firstSentAt ??= blockContext.number;
        yield* rpc
          .requestAll({
            method: "eth_sendRawTransaction",
            params: [entry.raw!],
          })
          .pipe(
            Effect.catch((error) =>
              Effect.logDebug("Failed settlement broadcast", error).pipe(
                Effect.annotateLogs({ transaction_hash: entry.hash }),
              ),
            ),
            Effect.forkIn(scope),
          );
      });

    // Splits what is waiting into settlements and sends them without waiting
    // for their receipts.
    const settle = () =>
      Effect.gen(function* () {
        const prepared = yield* withSpeculativeStateLock(
          Effect.gen(function* () {
            if (resync !== undefined) return undefined;
            const resubmit = reverted;
            reverted = undefined;
            const acceptedBatches = yield* Queue.clear(acceptedBatchesQueue);
            const queueIndexes = [
              ...(resubmit?.queueIndexes ?? []),
              ...(yield* Queue.clear(enqueuedQueue)),
            ];
            let batches = [
              ...(resubmit?.batches ?? []),
              ...acceptedBatches.map(({ id }) => batchesById.get(id)!),
            ];
            if (batches.length === 0 && queueIndexes.length === 0) {
              return undefined;
            }
            const commits = acceptedBatches.map(({ committed }) => committed);

            /** The enqueues that execute, in the order the settlements run them. */
            let forceExecuted: ForceExecution[] = resubmit?.forceExecuted ?? [];
            if (resubmit === undefined) {
              const executed: ForceExecution[] = [];
              const { timestamp } = blockContext;
              for (const queueIndex of queueIndexes) {
                const execution = yield* forceExecute(queueIndex, timestamp);
                if (execution !== undefined) executed.push(execution);
              }
              forceExecuted = executed;

              if (executed.length > 0) {
                commits.push(
                  yield* persist([
                    ...insertStorageSlots(app.typewriterSchema, executed),
                    ...insertKeccakPreimages(
                      app.typewriterSchema,
                      executed.flatMap(({ preimages }) => preimages),
                    ),
                  ]),
                );
              }
            }

            // A settlement lands only within MAX_SETTLEMENT_DELAY of the
            // timestamp it pins, so reverted or stale ones execute again now.
            const stale = (timestamp: bigint) =>
              blockContext.timestamp - timestamp >
              BigInt(EXPIRATION_MARGIN / 2);
            if (
              resubmit !== undefined ||
              batches.some((batch) => stale(timestampOf.get(batch)!)) ||
              forceExecuted.some(({ timestamp }) => stale(timestamp))
            ) {
              const reexecuted = yield* reexecute(
                batches,
                forceExecuted,
                queueIndexes,
              );
              batches = reexecuted.batches;
              forceExecuted = reexecuted.forceExecuted;
              commits.push(reexecuted.committed);
            }

            const settlements = toSettlements(batches, forceExecuted);
            if (settlements.length === 0) return undefined;
            const last = settlements.at(-1)!;
            if (last.batch === undefined) last.plan = yield* price(last);
            const executedQueueIndexes = new Set(
              forceExecuted.map(({ queueIndex }) => queueIndex),
            );
            settlements.at(-1)!.discardedQueueIndexes = queueIndexes.filter(
              (queueIndex) => !executedQueueIndexes.has(queueIndex),
            );

            // Given nonces under the lock, so an onchain revert stops them all.
            return {
              commits,
              transactions: settlements.map((settlement) => {
                const { gasLimit, accessList } =
                  settlement.plan ?? boundedPlan(settlement);
                const entry: Submitted = {
                  settlement,
                  nonce: nonce++,
                  gasLimit,
                  sentAt: 0n,
                  status: "pending",
                };
                submitted.set(entry.nonce, entry);
                return {
                  entry,
                  accessList,
                  gasLimit,
                  calldata: calldataOf(settlement),
                };
              }),
            };
          }),
        );

        if (prepared === undefined) return;

        yield* Effect.forEach(prepared.commits, Deferred.await, {
          discard: true,
        });

        for (const {
          entry,
          accessList,
          gasLimit,
          calldata,
        } of prepared.transactions) {
          yield* Effect.logDebug("Sending settlement transaction").pipe(
            Effect.annotateLogs({
              nonce: entry.nonce,
              gas_limit: gasLimit,
              size: Hex.size(calldata),
              mutation_count: entry.settlement.batch?.mutations.length ?? 0,
              enqueue_count: entry.settlement.forceExecuted.length,
            }),
          );
          entry.raw = yield* sign(calldata, gasLimit, accessList, entry.nonce);
          entry.hash = Hash.keccak256(entry.raw);
          yield* broadcast(entry);
        }
      });

    const finalize = (block: RuntimeBlock<"batch">) =>
      Effect.gen(function* () {
        block.status = "finalized";
        for (const batch of block.batches) {
          batch.status = "finalized";
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

        yield* emitBlockEvents(block);
      });

    const emitBlockEvents = (block: RuntimeBlock<"batch">) =>
      Effect.gen(function* () {
        yield* emitBlock(block);
        for (const batch of block.batches) {
          yield* emitBatch(batchToEvent(batch));
          for (const mutation of batch.mutations) {
            yield* emitMutation(mutationToEvent(mutation));
          }
        }
      });

    type Receipt = ReturnType<typeof formatTransactionReceipt>;

    // Like the watch's poll, a request on its path retries until it succeeds.
    const untilSuccess = <value, error>(effect: Effect.Effect<value, error>) =>
      effect.pipe(
        Effect.tapError((error) =>
          Effect.logWarning("Failed to request for a block", error),
        ),
        Effect.retry({
          schedule: Schedule.spaced(
            Duration.millis(app.blockPollingIntervalMs),
          ),
        }),
        // A forever schedule never gives up.
        Effect.orDie,
      );

    const requestReceipt = (hash: Hex.Hex, block: LocalBlock) =>
      Effect.gen(function* () {
        const reorged = new SettlementReorgedError({
          blockNumber: block.number,
          blockHash: block.hash,
        });
        for (let attempt = 1; ; attempt++) {
          const receipt = yield* untilSuccess(
            rpc.request({
              method: "eth_getTransactionReceipt",
              params: [hash],
            }),
          );
          if (receipt?.blockHash === block.hash) {
            return formatTransactionReceipt(receipt);
          }
          if (receipt !== null) return yield* reorged;
          // A provider behind the watch's has no receipt yet, unless a reorg removed the block.
          if (attempt % 10 === 0) {
            const canonical = yield* untilSuccess(
              requestBlock(block.number).pipe(Effect.provideService(Rpc, rpc)),
            );
            if (canonical.hash !== block.hash) return yield* reorged;
            yield* Effect.logWarning("Waiting for a settlement receipt").pipe(
              Effect.annotateLogs({ transaction_hash: hash, attempt }),
            );
          }
          yield* Effect.sleep(Duration.millis(app.blockPollingIntervalMs));
        }
      });

    const include = (
      settlement: Settlement,
      receipt: Receipt,
      runtimeBlock: RuntimeBlock<"batch">,
    ) =>
      Effect.gen(function* () {
        const inclusion: Inclusion = {
          blockNumber: runtimeBlock.number,
          blockHash: runtimeBlock.hash,
          blockTimestamp: runtimeBlock.timestamp,
          transactionHash: receipt.transactionHash,
          transactionIndex: receipt.transactionIndex,
        };
        const batches =
          settlement.batch === undefined ? [] : [settlement.batch];
        for (const batch of batches) {
          batch.status = "included";
          for (const mutation of batch.mutations) {
            updateMutationToIncluded(mutation as AcceptedMutation, inclusion);
          }
        }
        runtimeBlock.batches.push(...batches);
        if (settlement.forceExecuted.length > 0) {
          forceExecutedJournalIds.set(runtimeBlock, [
            ...(forceExecutedJournalIds.get(runtimeBlock) ?? []),
            ...settlement.forceExecuted.map(
              ({ executeResult }) => executeResult.journal_id,
            ),
          ]);
        }

        yield* Deferred.await(
          yield* persist(
            updateMutationInclusion(
              app.mutationSchema,
              batches.flatMap((batch) => batch.mutations),
              inclusion,
            ),
          ),
        );
      });

    // Once every settlement has landed, the chain is at the first reverted
    // one, and the reverted settlements execute again from there.
    const resynchronize = (block: LocalBlock) =>
      Effect.gen(function* () {
        const settlements = resync!;
        if (
          [...submitted.values()].some(
            ({ status, raw }) => status === "pending" || raw === undefined,
          )
        ) {
          return;
        }
        const [first] = settlements;
        const { timestamp } = first!.settlement;
        const landed = first!.block!;
        // Only a late landing is fixed by executing again in a newer block.
        if (
          timestamp <= landed.timestamp &&
          landed.timestamp - timestamp <= BigInt(EXPIRATION_MARGIN)
        ) {
          return yield* new SettlementRevertedError({
            transactionHash: first!.hash!,
          });
        }
        const fromExecutionHash = fromExecutionHashOfSettlement(
          first!.settlement,
        );
        const onchain = yield* untilSuccess(
          requestExecutionHash(app.address, block.hash).pipe(
            Effect.provideService(Rpc, rpc),
          ),
        );
        if (onchain !== fromExecutionHash) {
          return yield* new ResyncMismatchError({
            blockNumber: block.number,
            expected: fromExecutionHash,
            actual: onchain,
          });
        }
        yield* Effect.logWarning(
          "Resynchronized after a reverted settlement",
        ).pipe(
          Effect.annotateLogs({
            transaction_hash: first!.hash,
            reverted_count: settlements.length,
            execution_index: executionsOf(first!.settlement)[0]!.executionIndex,
          }),
        );
        resync = undefined;
        reverted = {
          batches: settlements.flatMap(({ settlement }) =>
            settlement.batch === undefined ? [] : [settlement.batch],
          ),
          forceExecuted: settlements.flatMap(
            ({ settlement }) => settlement.forceExecuted,
          ),
          queueIndexes: settlements
            .flatMap(({ settlement }) => [
              ...settlement.forceExecuted.map(({ queueIndex }) => queueIndex),
              ...settlement.discardedQueueIndexes,
            ])
            .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
        };
        yield* Queue.offer(submitSignal, undefined);
      });

    // Settles our transactions in `block`, in order. revm is at `block`, so a
    // revert executes again in it.
    const settleBlock = (block: LocalBlock) =>
      Effect.gen(function* () {
        const unlanded = () =>
          [...submitted.values()].filter(({ status }) => status === "pending");
        const byHash = new Map(unlanded().map((entry) => [entry.hash, entry]));
        const ours = block.transactions.flatMap(
          (hash) => byHash.get(hash) ?? [],
        );
        const receipts = yield* Effect.forEach(
          ours,
          (entry) => requestReceipt(entry.hash!, block),
          { concurrency: "unbounded" },
        );

        yield* withSpeculativeStateLock(
          Effect.gen(function* () {
            const runtimeBlock: RuntimeBlock<"batch"> = {
              status: "included",
              number: block.number,
              hash: block.hash,
              timestamp: block.timestamp,
              batches: [],
            };
            let settled = false;
            for (const [i, entry] of ours.entries()) {
              const receipt = receipts[i]!;
              entry.block = {
                number: block.number,
                hash: block.hash,
                timestamp: block.timestamp,
              };
              yield* Effect.logDebug("Landed settlement transaction").pipe(
                Effect.annotateLogs({
                  transaction_hash: receipt.transactionHash,
                  status: receipt.status,
                  gas_limit: entry.gasLimit,
                  gas_used: receipt.gasUsed,
                }),
              );
              if (receipt.status === "success") {
                if (resync !== undefined) {
                  return yield* new SettlementAfterRevertError({
                    transactionHash: receipt.transactionHash,
                  });
                }
                entry.status = "included";
                yield* include(entry.settlement, receipt, runtimeBlock);
                settled = true;
              } else {
                entry.status = "reverted";
                if (resync === undefined) {
                  yield* Effect.logWarning(
                    "Settlement transaction reverted onchain",
                  ).pipe(
                    Effect.annotateLogs({
                      transaction_hash: receipt.transactionHash,
                    }),
                  );
                }
                resync ??= [];
                resync.push(entry);
              }
            }
            if (settled) {
              yield* emitBlockEvents(runtimeBlock);
              unfinalizedBlocks.push(runtimeBlock);
            }
            if (resync !== undefined) yield* resynchronize(block);
          }),
        );

        // A node can lose a transaction, and every later nonce waits on it.
        for (const [i, entry] of unlanded().entries()) {
          if (
            entry.raw === undefined ||
            block.number < entry.sentAt + (i === 0 ? 1n : REBROADCAST_BLOCKS)
          ) {
            continue;
          }
          if (block.number - entry.firstSentAt! > STUCK_BLOCKS) {
            // The watch can be behind the chain, where it already landed.
            const receipt = yield* untilSuccess(
              rpc.request({
                method: "eth_getTransactionReceipt",
                params: [entry.hash!],
              }),
            );
            if (receipt === null) {
              return yield* new SettlementStuckError({
                nonce: entry.nonce,
                transactionHash: entry.hash!,
              });
            }
            entry.firstSentAt = block.number;
          }
          yield* broadcast(entry);
        }
      });

    const watchProgram = watchChain({
      fromBlock: startBlock,
      pollIntervalMs: app.blockPollingIntervalMs,
      bufferSize: WATCH_BUFFER_SIZE,
      logFilter: {
        address: app.address,
        selector: toEventSelector(
          getAbiItem({ abi: TYPEWRITER_ABI, name: "ForceInclusionQueued" }),
        ),
      },
    }).pipe(
      Stream.runForEach((message) =>
        Effect.gen(function* () {
          if (message._tag === "Finalized") {
            for (const entry of submitted.values()) {
              if (
                entry.block !== undefined &&
                entry.block.number <= message.block.number
              ) {
                submitted.delete(entry.nonce);
              }
            }
            const finalized = unfinalizedBlocks.filter(
              (block) => block.number <= message.block.number,
            );
            unfinalizedBlocks = unfinalizedBlocks.filter(
              (block) => block.number > message.block.number,
            );
            for (const block of finalized) {
              yield* finalize(block);
            }
            return;
          }

          if (message._tag === "Removed") {
            if (
              [...submitted.values()].some(
                (entry) => entry.block?.hash === message.block.hash,
              )
            ) {
              return yield* new SettlementReorgedError({
                blockNumber: message.block.number,
                blockHash: message.block.hash,
              });
            }
            if (message.block.logs.length > 0) {
              return yield* new EnqueueReorgedError({
                blockNumber: message.block.number,
                blockHash: message.block.hash,
              });
            }
            yield* Effect.logInfo("Removed reorged block").pipe(
              Effect.annotateLogs({
                block_number: message.block.number,
                block_hash: message.block.hash,
              }),
            );
            return;
          }

          yield* evm.setBlockContext({
            number: Hex.fromNumber(message.block.number),
            timestamp: Hex.fromNumber(message.block.timestamp),
          });
          blockContext = {
            number: message.block.number,
            timestamp: message.block.timestamp,
          };

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
            yield* Queue.offer(submitSignal, undefined);
          }

          yield* settleBlock(message.block);
        }),
      ),
      Effect.provideService(Rpc, rpc),
    );

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
    const submitProgram = Effect.forever(
      Queue.take(submitSignal).pipe(Effect.andThen(settle)),
    );

    const persistProgram = Effect.forever(
      Effect.gen(function* () {
        const jobs = yield* Queue.takeAll(persistQueue);
        const persistStartedAt = yield* startTimer;
        yield* db.run(jobs.flatMap(({ statements }) => statements));
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
      [batchProgram, submitProgram, persistProgram, watchProgram],
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
      input: RuntimeExecuteInput,
    ): Effect.Effect<TypewriterMutationResult, ExecuteError> {
      return Effect.gen(function* () {
        const mutation = structuredClone(input);
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
