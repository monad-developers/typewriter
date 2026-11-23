import {
  Deferred,
  Duration,
  Effect,
  Fiber,
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
  decodeEventLog,
  formatTransactionReceipt,
  getAbiItem,
  type TransactionReceipt,
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
import { deploymentLockKey, dropSchema, migrate } from "./db-migrate";
import {
  accountStorage,
  clearMutationInclusion,
  deleteExecutionsFrom,
  includeBlockMutations,
  insertKeccakPreimages,
  insertMutations,
  insertStorageSlots,
  selectKeccakPreimages,
  selectStorageSlots,
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
import { accessList, gasLimit, groupByGas, SETTLEMENT_GAS } from "./gas";
import { durationMs, startTimer } from "./logger";
import { executeInputSchema, mutationNameGuard } from "./mutation-schema";
import { Rpc } from "./rpc";
import {
  requestBlock,
  requestExecutionHash,
  requestExecutionIndex,
  requestNonce,
} from "./rpc-request";
import { EXPIRATION_MARGIN, TYPEWRITER_ABI } from "./typewriter-constants";
import {
  ChainIdMismatchError,
  type CreateTypewriterError,
  decodeRevert,
  EncodeMutationError,
  EnqueueHaltedError,
  EnqueueRevertedError,
  type ExecuteError,
  type ExecuteMutationError,
  InvalidMutationError,
  MutationExpiresTooSoonError,
  MutationHaltedError,
  MutationRevertedError,
  MutationTooLargeError,
  type ProgramError,
  ProgramStoppedError,
  ResyncMismatchError,
  revertMessage,
  SettlementAfterRevertError,
  SettlementRevertedError,
  SettlementStuckError,
  SignTransactionError,
  TypewriterStoppedError,
  UnknownMutationError,
} from "./typewriter-errors";
import type {
  AcceptedMutation,
  Authorization,
  BatchEvent,
  BatchListener,
  BlockEvent,
  BlockListener,
  ExecuteInput,
  IncludedMutation,
  Inclusion,
  LandedSettlement,
  MutationEvent,
  MutationListener,
  On,
  ReceivedMutation,
  RejectedMutation,
  RuntimeBatch,
  RuntimeBlock,
  RuntimeMutation,
  RuntimeSettlement,
  SentSettlement,
  SettlementBase,
  TypewriterMutationInput,
} from "./typewriter-types";
import {
  type FetchedBlock,
  type LocalBlock,
  type LocalLog,
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
  ) => Effect.Effect<void, ExecuteError>;
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

const WATCH_BUFFER_SIZE = 16;

const SLOT_CACHE_MAX_ENTRIES = 200_000;

/** How many blocks a sent settlement waits before it is sent again. */
const REBROADCAST_BLOCKS = 3n;

/** How many blocks a settlement can go without landing after it is first sent. */
const STUCK_BLOCKS = 300n;

/**
 * Every settlement's fee cap: 100 times Monad's minimum base fee of 100 gwei.
 * A settlement is signed once and sent again unchanged, so it can land only
 * while the base fee is under this. It pays only the base fee plus the tip,
 * and Monad checks balances against that, not the cap, so a high cap costs
 * nothing.
 */
const MAX_FEE_PER_GAS = 10_000_000_000_000n;

/** Every settlement's tip, what `eth_maxPriorityFeePerGas` returns on Monad. */
const MAX_PRIORITY_FEE_PER_GAS = 2_000_000_000n;

type RuntimeExecuteInput = {
  name: string;
  params: unknown;
  authorization: ExecuteInput<Authorization>;
};

/** A mutation from `execute`, or the queue index of an enqueue to force-execute. */
type Work =
  | {
      mutation: ReceivedMutation;
      /** Resolves once the mutation's row commits, or fails once it is rejected. */
      reply: Deferred.Deferred<AcceptedMutation, ExecuteMutationError>;
    }
  | { queueIndex: bigint };

/** One execution in revm, alone, before it settles with others. */
type Execution = {
  mutation: { executionIndex: bigint };
  /** The `executionHash` it executed from. */
  fromExecutionHash: Hex.Hex;
  executeResult: Extract<ExecuteResult, { status: "success" }>;
  /** The calldata it executed with, alone. */
  calldata: Hex.Hex;
};

/**
 * Moves `value` to the `to` status in place, so everything that holds it
 * sees the change. `fields` are the fields that `to` adds.
 */
function updateStatus<
  from extends { status: string },
  to extends { status: string },
>(value: from, fields: Omit<to, Exclude<keyof from, "status">>): to {
  // @ts-expect-error `from` and `to` have different statuses, and `fields` sets it.
  return Object.assign(value, fields);
}

function updateMutationToAccepted(
  mutation: ReceivedMutation,
  executionIndex: bigint,
): AcceptedMutation {
  return updateStatus<ReceivedMutation, AcceptedMutation>(mutation, {
    status: "accepted",
    executionIndex,
  });
}

function updateMutationToRejected(
  mutation: ReceivedMutation,
  error: ExecuteMutationError,
): RejectedMutation {
  return updateStatus<ReceivedMutation, RejectedMutation>(mutation, {
    status: "rejected",
    error,
  });
}

function updateMutationToIncluded(
  mutation: AcceptedMutation,
  inclusion: Inclusion,
): IncludedMutation {
  return updateStatus<AcceptedMutation, IncludedMutation>(mutation, {
    ...inclusion,
    status: "included",
  });
}

function updateMutationToUnincluded(
  mutation: IncludedMutation,
): AcceptedMutation {
  const unincluded = mutation as Partial<IncludedMutation>;
  delete unincluded.blockNumber;
  delete unincluded.blockHash;
  delete unincluded.blockTimestamp;
  delete unincluded.transactionHash;
  delete unincluded.transactionIndex;
  unincluded.status = "accepted" as never;
  return unincluded as unknown as AcceptedMutation;
}

/** `mutation` as it was before it executed, to execute it again. */
function toUnexecuted(mutation: AcceptedMutation): ReceivedMutation {
  const { name, params, authorization, config } = mutation;
  return { name, params, authorization, config, status: "received" };
}

function mutationToEvent(mutation: RuntimeMutation): MutationEvent {
  const { config: _config, ...event } = mutation;
  return event as MutationEvent;
}

function batchToEvent(batch: RuntimeBatch): BatchEvent {
  return {
    ...batch,
    mutations: batch.mutations.map(mutationToEvent),
  } as BatchEvent;
}

/** The `execute` calldata of `mutation` alone. Fails if a field is malformed. */
function encodeMutation(
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

function toBlockParams(block: { number: bigint; timestamp: bigint }) {
  return {
    number: Hex.fromNumber(block.number),
    timestamp: Hex.fromNumber(block.timestamp),
  };
}

function settlementCalldata(
  settlement: Pick<
    RuntimeSettlement,
    "fromExecutionHash" | "timestamp" | "batch" | "queueIndexes"
  >,
): Hex.Hex {
  return encodeExecuteCalldata(
    settlement.fromExecutionHash,
    settlement.timestamp,
    settlement.batch === undefined
      ? EMPTY_BATCH
      : encodeBatchArg(settlement.batch.mutations),
    settlement.queueIndexes,
  );
}

/** The arguments of an `enqueue` call, from its `ForceInclusionQueued` log. */
type ForceInclusionQueued = {
  index: bigint;
  mutation: number;
  mutationData: Hex.Hex;
  authorizationData: Hex.Hex;
};

function decodeForceInclusionQueued(log: LocalLog): ForceInclusionQueued {
  return decodeEventLog({
    abi: TYPEWRITER_ABI,
    eventName: "ForceInclusionQueued",
    topics: log.topics,
    data: log.data,
    strict: true,
  }).args;
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
    /** The keccak256 preimages the storage view enumerates mapping keys from. */
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
    // TODO(kyle) validate the fixed Typewriter entrypoints

    // -------------------------------------------------------------------------
    // Startup

    const db = yield* Database;
    const rpc = yield* Rpc;
    const scope = yield* Scope.Scope;

    const [chainIds] = yield* Effect.all(
      [
        rpc.requestEach({ method: "eth_chainId" }),
        rpc.requestEach({
          method: "eth_getBlockByNumber",
          params: ["finalized", false],
        }),
      ],
      { concurrency: "unbounded" },
    );
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
    const [code, startExecutionIndex, startNonce] = yield* Effect.all(
      [
        rpc.request({
          method: "eth_getCode",
          params: [app.address, { blockHash: startBlock.hash }],
        }),
        requestExecutionIndex(app.address, startBlock.hash),
        requestNonce(app.account.address),
      ],
      { concurrency: "unbounded" },
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
      startExecutionIndex,
    );

    const { evm, accounts, state, preimages, invalidateStorageCache } =
      yield* createRuntimeState(app, db, code);

    // -------------------------------------------------------------------------
    // State

    /** The chain's newest block, not the watch's, so a lagging watch can't make settlements land late. */
    let latest = {
      number: startBlock.number,
      timestamp: startBlock.timestamp,
    };
    /** The newest block the watch has added, which rebroadcasts count from. */
    let watched = startBlock.number;
    let nextExecutionIndex = startExecutionIndex;
    let nextNonce = startNonce;
    let nextBatchId = 0;
    /** Every settlement not yet final, in nonce order. */
    let settlements: RuntimeSettlement[] = [];
    /** Blocks with enqueues, which the evm replays once they are final. */
    let unfinalizedEnqueues: LocalBlock[] = [];
    /** Enqueues that failed in the evm, to force-execute again after a resync. */
    const discardedQueueIndexes: bigint[] = [];
    /** Receipts of sent settlements, requested as soon as the watch fetches their block. */
    const prefetchedReceipts = new Map<
      string,
      { number: bigint; receipt: Fiber.Fiber<TransactionReceipt | undefined> }
    >();

    /**
     * From an onchain revert until the settlements from it on are final and
     * execute again. Nothing is accepted meanwhile.
     */
    const resyncing = () =>
      settlements.some(({ status }) => status === "reverted");
    /** Guards the evm. Whoever executes a group holds it for the whole group. */
    const withEvm = Semaphore.withPermits(yield* Semaphore.make(1), 1);

    const inbox = yield* Queue.unbounded<Work>();
    yield* Scope.addFinalizer(scope, Queue.shutdown(inbox));
    const stopped = yield* Deferred.make<never, TypewriterStoppedError>();

    const mutationListeners = new Set<MutationListener>();
    const batchListeners = new Set<BatchListener>();
    const blockListeners = new Set<BlockListener<"fifo" | "batch">>();

    const isMutationName = mutationNameGuard(Object.keys(app.mutations));
    const executeInputSchemas = new Map(
      Object.entries(app.mutations).map(([name, config]) => [
        name,
        executeInputSchema(name, config.params),
      ]),
    );
    const batchOrderByName = new Map(
      (app.sequencing.order === "batch" ? app.sequencing.batchOrder : []).map(
        (name, position) => [name, position],
      ),
    );
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

    // -------------------------------------------------------------------------
    // Events and persistence

    /** Calls `listeners` with `event`, which is built now and delivered later. */
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

    const emitMutation = (mutation: RuntimeMutation) =>
      emit(
        "mutation",
        mutationListeners,
        mutationToEvent(mutation),
        (event) => {
          if (event.status !== "rejected") return structuredClone(event);
          const { error, ...rest } = event;
          return { ...structuredClone(rest), error };
        },
      );

    const emitBatch = (batch: RuntimeBatch) =>
      app.sequencing.order === "batch"
        ? emit("batch", batchListeners, batchToEvent(batch))
        : Effect.void;

    const emitBlock = (block: RuntimeBlock) => {
      const { batches, ...rest } = block;
      return [
        emit(
          "block",
          blockListeners,
          (app.sequencing.order === "fifo"
            ? {
                ...rest,
                mutations: batches.flatMap((batch) =>
                  batch.mutations.map(mutationToEvent),
                ),
              }
            : { ...rest, batches: batches.map(batchToEvent) }) as BlockEvent<
            "fifo" | "batch"
          >,
        ),
        ...batches.flatMap((batch) => [
          emitBatch(batch),
          ...batch.mutations.map(emitMutation),
        ]),
      ];
    };

    /**
     * The database writer. Every write goes through its queue, so writes
     * commit in the order they are queued, many in one transaction.
     */
    const writes = yield* Queue.unbounded<{
      statements: CompiledStatement[];
      committed: Deferred.Deferred<void>;
    }>();
    yield* Scope.addFinalizer(scope, Queue.shutdown(writes));

    /** Queues `statements` now, and returns what resolves once they commit. */
    const write = (statements: DbStatement<unknown>[]) => {
      const committed = Deferred.makeUnsafe<void>();
      Queue.offerUnsafe(writes, {
        statements: statements.map(compile),
        committed,
      });
      return committed;
    };

    /**
     * Resolves once the latest group's replies and events are out. Each group
     * waits for the one before it, and the watch for the groups queued before
     * its writes, so events go out in the order their writes were queued.
     */
    let emitted: Effect.Effect<void> = Effect.void;

    const writerProgram = Effect.forever(
      Effect.gen(function* () {
        const jobs = yield* Queue.takeAll(writes);
        const statements = jobs.flatMap(({ statements }) => statements);
        if (statements.length > 0) {
          const startedAt = yield* startTimer;
          yield* db.run(statements);
          yield* Effect.logDebug("Persisted runtime writes").pipe(
            Effect.annotateLogs({
              job_count: jobs.length,
              duration: yield* durationMs(startedAt),
            }),
          );
        }
        for (const { committed } of jobs) {
          yield* Deferred.succeed(committed, undefined);
        }
      }),
    );

    // -------------------------------------------------------------------------
    // Submission

    // Sends to every provider, and is sent again until it lands, so a
    // provider that fails or answers wrongly only delays it.
    const broadcast = (settlement: SentSettlement) =>
      rpc
        .requestAll({
          method: "eth_sendRawTransaction",
          params: [settlement.raw],
        })
        .pipe(
          Effect.catch((error) =>
            Effect.logDebug("Failed settlement broadcast", error).pipe(
              Effect.annotateLogs({ transaction_hash: settlement.hash }),
            ),
          ),
          Effect.forkIn(scope),
        );

    const sign = (settlement: SettlementBase) =>
      Effect.tryPromise({
        try: () =>
          app.account.signTransaction({
            type: "eip1559",
            chainId: app.chainId,
            nonce: settlement.nonce,
            to: app.address,
            data: settlementCalldata(settlement),
            gas: BigInt(settlement.gasLimit),
            accessList: settlement.accessList,
            maxFeePerGas: MAX_FEE_PER_GAS,
            maxPriorityFeePerGas: MAX_PRIORITY_FEE_PER_GAS,
          }) as Promise<Hex.Hex>,
        catch: (cause) => new SignTransactionError({ cause }),
      });

    // -------------------------------------------------------------------------
    // Execution in the evm, always under `withEvm`

    const readExecutionHash = evm
      .readStorage({ address: app.address, slots: [executionHashSlot] })
      .pipe(Effect.map((values) => Hex.padLeft(Object.values(values)[0]!, 32)));

    /** Updates the storage view for an execution. */
    const recordExecution = (
      executeResult: ExecuteResult,
      newPreimages: Hex.Hex[],
    ) => {
      invalidateStorageCache(
        executeResult.slot_writes.map((write) => write.slot),
      );
      for (const preimage of executeResult.keccak_preimages) {
        if (preimages.has(preimage)) continue;
        preimages.add(preimage);
        newPreimages.push(preimage);
      }
    };

    /** Rejects a mutation whose authorization or credential expires before `minExpiration`. */
    const checkExpiration = (
      mutation: ReceivedMutation,
      minExpiration: number,
    ): Effect.Effect<void, MutationExpiresTooSoonError> =>
      Effect.gen(function* () {
        const { authorization } = mutation;
        if (
          authorization.expiration !== 0 &&
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
              credentials: { [index: number]: { expiration: number } };
            }
          >
        )[authorization.accountID]!;
        const credentialExpiration =
          credentials[Number(authorization.credentialID)]!.expiration;
        if (
          credentialExpiration !== 0 &&
          credentialExpiration < minExpiration
        ) {
          return yield* new MutationExpiresTooSoonError({
            expiration: credentialExpiration,
            minExpiration,
          });
        }
      });

    const executeMutation = (
      mutation: ReceivedMutation,
      newPreimages: Hex.Hex[],
      block: { number: bigint; timestamp: bigint },
    ) =>
      Effect.gen(function* () {
        const { timestamp } = block;
        const fromExecutionHash = yield* readExecutionHash;
        const calldata = yield* encodeMutation(
          mutation,
          fromExecutionHash,
          timestamp,
        );
        yield* checkExpiration(mutation, Number(timestamp) + EXPIRATION_MARGIN);
        const executeResult = yield* evm.execute({
          from: app.account.address,
          to: app.address,
          data: calldata,
          block: toBlockParams(block),
        });
        if (executeResult.status === "revert") {
          return yield* new MutationRevertedError(
            decodeRevert(app.abi, executeResult.data),
          );
        }
        if (executeResult.status === "halt") {
          return yield* new MutationHaltedError({
            reason: executeResult.reason,
          });
        }
        if (executeResult.gas_used > SETTLEMENT_GAS) {
          yield* evm.revertJournals({
            journal_ids: [executeResult.journal_id],
          });
          invalidateStorageCache();
          return yield* new MutationTooLargeError({
            gas: executeResult.gas_used,
          });
        }
        recordExecution(executeResult, newPreimages);
        return {
          mutation: updateMutationToAccepted(mutation, nextExecutionIndex++),
          fromExecutionHash,
          executeResult,
          calldata,
        };
      });

    /** Force-executes an enqueue, or returns `undefined` if it fails. */
    const executeEnqueue = (
      queueIndex: bigint,
      newPreimages: Hex.Hex[],
      block: { number: bigint; timestamp: bigint },
    ) =>
      Effect.gen(function* () {
        const fromExecutionHash = yield* readExecutionHash;
        const calldata = encodeExecuteCalldata(
          fromExecutionHash,
          block.timestamp,
          EMPTY_BATCH,
          [queueIndex],
        );
        const executeResult = yield* evm.execute({
          from: app.account.address,
          to: app.address,
          data: calldata,
          block: toBlockParams(block),
        });
        if (
          executeResult.status === "success" &&
          executeResult.gas_used <= SETTLEMENT_GAS
        ) {
          recordExecution(executeResult, newPreimages);
          return {
            queueIndex,
            mutation: { executionIndex: nextExecutionIndex++ },
            fromExecutionHash,
            executeResult,
            calldata,
          };
        }
        if (executeResult.status === "success") {
          yield* evm.revertJournals({
            journal_ids: [executeResult.journal_id],
          });
          invalidateStorageCache();
        }
        yield* Effect.logWarning(
          executeResult.status === "revert"
            ? revertMessage(
                "Discarded enqueued mutation",
                decodeRevert(app.abi, executeResult.data),
              )
            : "Discarded enqueued mutation",
        ).pipe(Effect.annotateLogs({ queue_index: queueIndex }));
        return undefined;
      });

    /**
     * Executes a group: its mutations, then its enqueues. What executes is
     * split into settlements, each signed with the next nonce and broadcast.
     * Its rows are queued to commit, and once they do each `reply` resolves
     * and its events are emitted.
     * `batch` is the group's batch when it executes again after a resync.
     */
    const executeGroup = (
      received: {
        mutation: ReceivedMutation;
        reply?: Deferred.Deferred<AcceptedMutation, ExecuteMutationError>;
      }[],
      queueIndexes: bigint[],
      batch?: RuntimeBatch,
    ) =>
      Effect.gen(function* () {
        const block = latest;
        // Preimages are loaded from Postgres at startup and survive rewinds.
        const newPreimages: Hex.Hex[] = [];
        const accepted: (Execution & { mutation: AcceptedMutation })[] = [];
        const outcomes: (AcceptedMutation | RejectedMutation)[] = [];
        const replies: {
          reply: Deferred.Deferred<AcceptedMutation, ExecuteMutationError>;
          mutation: AcceptedMutation;
        }[] = [];
        for (const { mutation, reply } of received) {
          const result = yield* Effect.result(
            executeMutation(mutation, newPreimages, block),
          );
          if (Result.isFailure(result)) {
            outcomes.push(updateMutationToRejected(mutation, result.failure));
            if (reply) yield* Deferred.fail(reply, result.failure);
            continue;
          }
          accepted.push(result.success);
          outcomes.push(result.success.mutation);
          if (reply) replies.push({ reply, mutation: result.success.mutation });
        }
        const forced: (Execution & { queueIndex: bigint })[] = [];
        for (const queueIndex of queueIndexes) {
          const execution = yield* executeEnqueue(
            queueIndex,
            newPreimages,
            block,
          );
          if (execution === undefined) discardedQueueIndexes.push(queueIndex);
          else forced.push(execution);
        }

        const events = outcomes.map(emitMutation);
        const executions = [...accepted, ...forced];
        const groups = groupByGas(app.hardfork, executions).map(
          (group): SettlementBase => {
            const mutations = group.flatMap((execution) =>
              "queueIndex" in execution ? [] : [execution.mutation],
            );
            let groupBatch: RuntimeBatch | undefined;
            if (mutations.length > 0 && batch !== undefined) {
              groupBatch = Object.assign(batch, { mutations });
              batch = undefined;
            } else if (mutations.length > 0) {
              groupBatch = { status: "accepted", id: nextBatchId++, mutations };
              events.push(emitBatch(groupBatch));
            }
            return {
              nonce: nextNonce++,
              timestamp: block.timestamp,
              fromExecutionHash: group[0]!.fromExecutionHash,
              fromExecutionIndex: group[0]!.mutation.executionIndex,
              batch: groupBatch,
              queueIndexes: group.flatMap((execution) =>
                "queueIndex" in execution ? [execution.queueIndex] : [],
              ),
              journalIds: group.map(
                ({ executeResult }) => executeResult.journal_id,
              ),
              gasLimit: gasLimit(app.hardfork, group),
              accessList: accessList(app.hardfork, group),
            };
          },
        );
        const committed = write([
          ...insertMutations(
            app.mutationSchema,
            accepted.map(({ mutation }) => mutation),
          ),
          ...insertStorageSlots(app.typewriterSchema, executions),
          ...insertKeccakPreimages(app.typewriterSchema, newPreimages),
        ]);
        const previous = emitted;
        const done = Deferred.makeUnsafe<void>();
        emitted = Deferred.await(done);
        // Reply and emit once the rows commit and the previous group's events
        // are out, without holding up the next group.
        yield* Effect.gen(function* () {
          yield* Deferred.await(committed);
          yield* previous;
          for (const { reply, mutation } of replies) {
            yield* Deferred.succeed(reply, mutation);
          }
          for (const event of events) yield* event;
        }).pipe(
          Effect.ensuring(Deferred.succeed(done, undefined)),
          Effect.forkIn(scope),
        );

        // Signed under the evm lock, so in nonce order.
        for (const group of groups) {
          const raw = yield* sign(group);
          const settlement: SentSettlement = {
            ...group,
            status: "sent",
            raw,
            hash: Hash.keccak256(raw),
            sentAt: watched,
            firstSentAt: watched,
          };
          settlements.push(settlement);
          yield* Effect.logDebug("Sending settlement transaction").pipe(
            Effect.annotateLogs({
              nonce: settlement.nonce,
              transaction_hash: settlement.hash,
              gas_limit: settlement.gasLimit,
              mutation_count: settlement.batch?.mutations.length ?? 0,
              enqueue_count: settlement.queueIndexes.length,
            }),
          );
          yield* broadcast(settlement);
        }
      });

    // -------------------------------------------------------------------------
    // The accept worker: executes everything queued since its last round as
    // one group.

    const accept = Effect.gen(function* () {
      const work =
        app.sequencing.order === "batch"
          ? yield* Queue.clear(inbox)
          : yield* Queue.takeAll(inbox);
      const received = work.filter((item) => "mutation" in item);
      const queueIndexes = work.flatMap((item) =>
        "queueIndex" in item ? [item.queueIndex] : [],
      );
      if (received.length === 0 && queueIndexes.length === 0) return;
      received.sort(
        (a, b) =>
          (batchOrderByName.get(a.mutation.name) ?? batchOrderByName.size) -
          (batchOrderByName.get(b.mutation.name) ?? batchOrderByName.size),
      );
      queueIndexes.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
      // Mutations wait out a resync rather than execute on state it rewinds.
      while (
        !(yield* withEvm(
          resyncing()
            ? Effect.succeed(false)
            : executeGroup(received, queueIndexes).pipe(Effect.as(true)),
        ))
      ) {
        yield* Effect.sleep(Duration.millis(app.blockPollingIntervalMs));
      }
    });

    const acceptProgram =
      app.sequencing.order === "batch"
        ? Effect.sleep(Duration.millis(app.sequencing.batchIntervalMs)).pipe(
            Effect.andThen(
              Effect.repeat(
                accept,
                Schedule.fixed(Duration.millis(app.sequencing.batchIntervalMs)),
              ),
            ),
          )
        : Effect.forever(accept);

    // -------------------------------------------------------------------------
    // The watch worker: indexes the chain and handles each block in order.

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
        Effect.orDie,
      );

    /** The receipt of `hash` in `block`, or `undefined` if a reorg removed the block. */
    const requestReceipt = (hash: Hex.Hex, block: FetchedBlock) =>
      Effect.gen(function* () {
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
          // A provider behind the watch's, or on another fork, has another
          // answer, unless a reorg removed the block.
          if (attempt % 10 === 0) {
            const canonical = yield* untilSuccess(
              requestBlock(block.number).pipe(Effect.provideService(Rpc, rpc)),
            );
            if (canonical.hash !== block.hash) return undefined;
            yield* Effect.logWarning("Waiting for a settlement receipt").pipe(
              Effect.annotateLogs({ transaction_hash: hash, attempt }),
            );
          }
          yield* Effect.sleep(Duration.millis(app.blockPollingIntervalMs));
        }
      });

    const sentIn = (block: FetchedBlock) => {
      const transactions = new Set(block.transactions);
      return settlements.filter(
        (settlement): settlement is SentSettlement =>
          settlement.status === "sent" && transactions.has(settlement.hash),
      );
    };

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
          switch (message._tag) {
            case "Fetched": {
              const { block } = message;
              if (block.number > latest.number) {
                latest = { number: block.number, timestamp: block.timestamp };
              }
              for (const settlement of sentIn(block)) {
                const key = block.hash + settlement.hash;
                if (prefetchedReceipts.has(key)) continue;
                prefetchedReceipts.set(key, {
                  number: block.number,
                  receipt: yield* requestReceipt(settlement.hash, block).pipe(
                    Effect.forkIn(scope),
                  ),
                });
              }
              return;
            }

            case "Added": {
              const { block } = message;
              watched = block.number;
              if (block.logs.length > 0) unfinalizedEnqueues.push(block);

              // Record where our settlements landed, in order.
              const landed = sentIn(block);
              const receipts = yield* Effect.forEach(
                landed,
                (settlement) => {
                  const key = block.hash + settlement.hash;
                  const prefetched = prefetchedReceipts.get(key);
                  prefetchedReceipts.delete(key);
                  return prefetched === undefined
                    ? requestReceipt(settlement.hash, block)
                    : Fiber.join(prefetched.receipt);
                },
                { concurrency: "unbounded" },
              );
              // Unless a reorg removed the block, which the watch removes next.
              if (landed.length > 0 && !receipts.includes(undefined)) {
                const runtimeBlock: RuntimeBlock = {
                  status: "included",
                  number: block.number,
                  hash: block.hash,
                  timestamp: block.timestamp,
                  batches: [],
                };
                const included: IncludedMutation[] = [];
                for (const [i, settlement] of landed.entries()) {
                  const receipt = receipts[i]!;
                  yield* Effect.logDebug("Landed settlement transaction").pipe(
                    Effect.annotateLogs({
                      transaction_hash: receipt.transactionHash,
                      status: receipt.status,
                      gas_limit: settlement.gasLimit,
                      gas_used: receipt.gasUsed,
                    }),
                  );
                  if (receipt.status === "reverted") {
                    if (!resyncing()) {
                      yield* Effect.logWarning(
                        "Settlement transaction reverted onchain",
                      ).pipe(
                        Effect.annotateLogs({
                          transaction_hash: receipt.transactionHash,
                        }),
                      );
                    }
                    updateStatus<SentSettlement, LandedSettlement>(settlement, {
                      status: "reverted",
                      block: runtimeBlock,
                    });
                    continue;
                  }
                  if (resyncing()) {
                    return yield* new SettlementAfterRevertError({
                      transactionHash: receipt.transactionHash,
                    });
                  }
                  updateStatus<SentSettlement, LandedSettlement>(settlement, {
                    status: "included",
                    block: runtimeBlock,
                  });
                  const { batch } = settlement;
                  if (batch === undefined) continue;
                  batch.status = "included";
                  for (const mutation of batch.mutations) {
                    included.push(
                      updateMutationToIncluded(mutation as AcceptedMutation, {
                        blockNumber: block.number,
                        blockHash: block.hash,
                        blockTimestamp: block.timestamp,
                        transactionHash: settlement.hash,
                        transactionIndex: receipt.transactionIndex,
                      }),
                    );
                  }
                  runtimeBlock.batches.push(batch);
                }
                // Its mutations' `accepted` events go out first.
                const earlier = emitted;
                yield* Deferred.await(
                  write(
                    includeBlockMutations(
                      app.mutationSchema,
                      runtimeBlock,
                      included,
                    ),
                  ),
                );
                yield* earlier;
                if (receipts.some((receipt) => receipt!.status === "success")) {
                  for (const event of emitBlock(runtimeBlock)) yield* event;
                }
              }

              // Send again what has waited a few blocks to land.
              for (const settlement of settlements) {
                if (
                  settlement.status !== "sent" ||
                  block.number < settlement.sentAt + REBROADCAST_BLOCKS
                ) {
                  continue;
                }
                settlement.sentAt = block.number;
                if (block.number - settlement.firstSentAt <= STUCK_BLOCKS) {
                  yield* broadcast(settlement);
                  continue;
                }
                // The watch can be behind the chain, where it already landed.
                const receipt = yield* untilSuccess(
                  rpc.request({
                    method: "eth_getTransactionReceipt",
                    params: [settlement.hash],
                  }),
                );
                if (receipt === null) {
                  return yield* new SettlementStuckError({
                    nonce: settlement.nonce,
                    transactionHash: settlement.hash,
                    blocks: STUCK_BLOCKS,
                  });
                }
                settlement.firstSentAt = block.number;
              }
              return;
            }

            // A reorg replaced `block`. Its settlements are sent again as
            // signed, and land with the same result, since each pins its
            // timestamp.
            case "Removed": {
              const { block } = message;
              unfinalizedEnqueues = unfinalizedEnqueues.filter(
                ({ hash }) => hash !== block.hash,
              );
              const removed = settlements.filter(
                (settlement): settlement is LandedSettlement =>
                  (settlement.status === "included" ||
                    settlement.status === "reverted") &&
                  settlement.block.hash === block.hash,
              );
              yield* Effect.logInfo("Removed reorged block").pipe(
                Effect.annotateLogs({
                  block_number: block.number,
                  block_hash: block.hash,
                  settlement_count: removed.length,
                }),
              );
              if (removed.length === 0) return;
              const runtimeBlock = removed[0]!.block;
              const included = removed.some(
                ({ status }) => status === "included",
              );
              for (const settlement of removed) {
                delete (settlement as Partial<LandedSettlement>).block;
                const sent = updateStatus<LandedSettlement, SentSettlement>(
                  settlement,
                  { status: "sent" },
                );
                sent.sentAt = 0n;
                sent.firstSentAt = watched;
              }
              if (!included) return;
              const mutations = runtimeBlock.batches.flatMap((batch) => {
                batch.status = "accepted";
                return batch.mutations.map((mutation) =>
                  updateMutationToUnincluded(mutation as IncludedMutation),
                );
              });
              const { number, hash, timestamp } = runtimeBlock;
              yield* Deferred.await(
                write(clearMutationInclusion(app.mutationSchema, mutations)),
              );
              yield* emit("block", blockListeners, {
                status: "removed",
                number,
                hash,
                timestamp,
              } as BlockEvent<"fifo" | "batch">);
              return;
            }

            case "Finalized": {
              const finalized = message.block;
              for (const [key, { number }] of prefetchedReceipts) {
                if (number <= finalized.number) prefetchedReceipts.delete(key);
              }
              // Requested before taking the evm, which the accept worker waits on.
              const onchain = resyncing()
                ? yield* untilSuccess(
                    requestExecutionHash(app.address, finalized.hash).pipe(
                      Effect.provideService(Rpc, rpc),
                    ),
                  )
                : undefined;

              yield* withEvm(
                Effect.gen(function* () {
                  // Every enqueue takes a queue index onchain, so the evm
                  // replays each one with its bytes once its block is final,
                  // where no reorg undoes it. The next group force-executes it.
                  for (const enqueued of unfinalizedEnqueues) {
                    if (enqueued.number > finalized.number) continue;
                    for (const log of enqueued.logs) {
                      const queued = decodeForceInclusionQueued(log);
                      const executeResult = yield* evm.execute({
                        from: "0x0000000000000000000000000000000000000000",
                        to: app.address,
                        data: encodeEnqueueCalldata(queued),
                        // An enqueue records its block's timestamp.
                        block: toBlockParams(enqueued),
                      });
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
                      yield* evm.pruneJournals({
                        journal_ids: [executeResult.journal_id],
                      });
                      invalidateStorageCache(
                        executeResult.slot_writes.map((write) => write.slot),
                      );
                      Queue.offerUnsafe(inbox, { queueIndex: queued.index });
                    }
                  }
                  unfinalizedEnqueues = unfinalizedEnqueues.filter(
                    ({ number }) => number > finalized.number,
                  );

                  // A final settlement's journals can't be rewound.
                  const final = settlements.filter(
                    (settlement): settlement is LandedSettlement =>
                      settlement.status === "included" &&
                      settlement.block.number <= finalized.number,
                  );
                  yield* evm.pruneJournals({
                    journal_ids: final.flatMap(({ journalIds }) => journalIds),
                  });
                  const isFinal = new Set<RuntimeSettlement>(final);
                  settlements = settlements.filter(
                    (settlement) => !isFinal.has(settlement),
                  );
                  for (const block of new Set(
                    final.map(({ block }) => block),
                  )) {
                    block.status = "finalized";
                    for (const batch of block.batches) {
                      batch.status = "finalized";
                      for (const mutation of batch.mutations) {
                        (mutation as IncludedMutation).status = "finalized";
                      }
                    }
                    for (const event of emitBlock(block)) yield* event;
                  }

                  // Once every settlement from the first revert on is final,
                  // the chain is where the first started, and they all
                  // execute again. A reorg can't undo a final revert.
                  if (
                    settlements.length === 0 ||
                    !settlements.every(
                      (settlement) =>
                        settlement.status === "reverted" &&
                        settlement.block.number <= finalized.number,
                    )
                  ) {
                    return;
                  }
                  const rewound = settlements as LandedSettlement[];
                  const first = rewound[0]!;
                  // Only a late landing is fixed by executing again at a newer timestamp.
                  if (
                    first.timestamp <= first.block.timestamp &&
                    first.block.timestamp - first.timestamp <=
                      BigInt(EXPIRATION_MARGIN)
                  ) {
                    return yield* new SettlementRevertedError({
                      transactionHash: first.hash,
                    });
                  }
                  if (onchain !== first.fromExecutionHash) {
                    return yield* new ResyncMismatchError({
                      blockNumber: finalized.number,
                      expected: first.fromExecutionHash,
                      actual: onchain!,
                    });
                  }
                  settlements = [];
                  yield* evm.revertJournals({
                    journal_ids: rewound.flatMap(
                      ({ journalIds }) => journalIds,
                    ),
                  });
                  invalidateStorageCache();
                  nextExecutionIndex = first.fromExecutionIndex;
                  const retried = discardedQueueIndexes.splice(0);
                  write(
                    deleteExecutionsFrom(
                      app.mutationSchema,
                      app.typewriterSchema,
                      nextExecutionIndex,
                    ),
                  );
                  for (const { batch, queueIndexes } of rewound) {
                    const received = (batch?.mutations ?? []).map(
                      (mutation) => ({
                        mutation: toUnexecuted(mutation as AcceptedMutation),
                      }),
                    );
                    yield* executeGroup(received, queueIndexes, batch);
                  }
                  for (const queueIndex of retried) {
                    Queue.offerUnsafe(inbox, { queueIndex });
                  }
                  yield* Effect.logWarning("Executed settlements again").pipe(
                    Effect.annotateLogs({
                      from_execution_index: first.fromExecutionIndex,
                      rewound_count: rewound.length,
                      settlement_count: settlements.length,
                    }),
                  );
                }),
              );
              return;
            }
          }
        }),
      ),
      Effect.provideService(Rpc, rpc),
    );

    // -------------------------------------------------------------------------
    // Programs

    const program = Effect.all([acceptProgram, writerProgram, watchProgram], {
      concurrency: "unbounded",
    }).pipe(
      Effect.andThen(Effect.fail(new ProgramStoppedError())),
      Effect.raceFirst(lockLost),
      // Mutations waiting for the program would otherwise wait forever.
      Effect.onError((cause) =>
        Deferred.fail(stopped, new TypewriterStoppedError({ cause })),
      ),
    );

    function execute(
      input: RuntimeExecuteInput,
    ): Effect.Effect<void, ExecuteError> {
      return Effect.gen(function* () {
        const mutation = structuredClone(input);
        if (!isMutationName(mutation.name)) {
          return yield* new UnknownMutationError({ mutation: mutation.name });
        }

        const { params, authorization } = yield* Schema.decodeUnknownEffect(
          executeInputSchemas.get(mutation.name)!,
        )(mutation).pipe(
          Effect.mapError(
            (cause) =>
              new InvalidMutationError({ mutation: mutation.name, cause }),
          ),
        );

        const runtimeMutation = {
          name: mutation.name,
          params,
          authorization,
          status: "received",
          config: app.mutations[mutation.name]!,
        } as const satisfies ReceivedMutation;

        yield* Effect.logDebug("Received mutation").pipe(
          Effect.annotateLogs({
            mutation: runtimeMutation.name,
            params: runtimeMutation.params,
          }),
        );

        yield* emitMutation(runtimeMutation);
        const reply = yield* Deferred.make<
          AcceptedMutation,
          ExecuteMutationError
        >();
        const acceptStartedAt = yield* startTimer;
        Queue.offerUnsafe(inbox, { mutation: runtimeMutation, reply });

        const acceptedMutation = yield* Deferred.await(reply).pipe(
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
          Effect.raceFirst(Deferred.await(stopped)),
        );

        yield* Effect.logDebug("Accepted mutation").pipe(
          Effect.annotateLogs({
            mutation: runtimeMutation.name,
            execution_index: acceptedMutation.executionIndex,
            duration: yield* durationMs(acceptStartedAt),
          }),
        );
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
