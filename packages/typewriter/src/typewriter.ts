import {
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
  decodeEventLog,
  formatTransactionReceipt,
  getAbiItem,
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
import { groupByGas, SETTLEMENT_GAS, settlementGasLimit } from "./gas";
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
  ExecutedSettlement,
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
  SigningSettlement,
  TypewriterMutationInput,
  TypewriterMutationResult,
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

const WATCH_BUFFER_SIZE = 16;

const SLOT_CACHE_MAX_ENTRIES = 200_000;

/** How many blocks a sent settlement waits before it is sent again. */
const REBROADCAST_BLOCKS = 3n;

/** How many blocks a settlement can go without landing after it is first sent. */
const STUCK_BLOCKS = 300n;

type RuntimeExecuteInput = {
  name: string;
  params: unknown;
  authorization: ExecuteInput<Authorization>;
};

/** Resolves once a mutation executes. Its row commits later, at `committed`. */
type AcceptDeferred = Deferred.Deferred<
  { mutation: AcceptedMutation; committed: Deferred.Deferred<void> },
  ExecuteMutationError
>;

/** One execution in revm, alone, before it settles with others. */
type Execution = {
  mutation: { executionIndex: bigint };
  /** The `executionHash` it executed from. */
  fromExecutionHash: Hex.Hex;
  executeResult: Extract<ExecuteResult, { status: "success" }>;
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
    const requestPriorityFee = rpc
      .request({ method: "eth_maxPriorityFeePerGas" })
      .pipe(Effect.map(Hex.toBigInt));
    const [code, startExecutionIndex, startNonce, startPriorityFee] =
      yield* Effect.all(
        [
          rpc.request({
            method: "eth_getCode",
            params: [app.address, { blockHash: startBlock.hash }],
          }),
          requestExecutionIndex(app.address, startBlock.hash),
          requestNonce(app.account.address),
          requestPriorityFee,
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
      baseFeePerGas: startBlock.baseFeePerGas ?? 0n,
    };
    /** The newest block the watch has processed, which rebroadcasts count from. */
    let watched = startBlock.number;
    let nextExecutionIndex = startExecutionIndex;
    let nextNonce = startNonce;
    let maxPriorityFeePerGas = startPriorityFee;
    let refreshingPriorityFee = false;
    let nextBatchId = 0;
    /** Every settlement not yet final, in execution order, which is nonce order. */
    let settlements: RuntimeSettlement[] = [];
    /** From an onchain revert until every settlement sent before it is final. Nothing is sent meanwhile. */
    let resyncing = false;
    /** Blocks with enqueues, which revm replays once they are final. */
    let unfinalizedEnqueues: LocalBlock[] = [];
    /** Enqueues replayed in revm, to force-execute in the next batch. */
    let pendingQueueIndexes: bigint[] = [];
    /** Enqueues that failed in revm, to try again after a resync frees what they need. */
    let discardedQueueIndexes: bigint[] = [];

    const receivedMutationQueue = yield* Queue.unbounded<{
      mutation: ReceivedMutation;
      deferred: AcceptDeferred;
    }>();
    const persistQueue = yield* Queue.unbounded<{
      statements: CompiledStatement[];
      committed: Deferred.Deferred<void>;
    }>();
    /** Wakes `accept` in fifo order when a mutation or an enqueue is waiting. */
    const acceptSignal = yield* Queue.sliding<void>(1);
    /** Wakes `send` when a settlement is waiting. */
    const sendSignal = yield* Queue.sliding<void>(1);
    yield* Scope.addFinalizer(scope, Queue.shutdown(receivedMutationQueue));
    yield* Scope.addFinalizer(scope, Queue.shutdown(acceptSignal));
    yield* Scope.addFinalizer(scope, Queue.shutdown(persistQueue));
    yield* Scope.addFinalizer(scope, Queue.shutdown(sendSignal));
    const stopped = yield* Deferred.make<never, TypewriterStoppedError>();

    /** Guards revm and `settlements`. */
    const withStateLock = Semaphore.withPermits(yield* Semaphore.make(1), 1);

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

    const emitBlock = (block: RuntimeBlock) =>
      Effect.gen(function* () {
        const { batches, ...rest } = block;
        yield* emit(
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
        );
        for (const batch of batches) {
          yield* emitBatch(batch);
          for (const mutation of batch.mutations) yield* emitMutation(mutation);
        }
      });

    const persist = (statements: DbStatement<unknown>[]) => {
      const compiled = statements.map(compile);
      return Effect.gen(function* () {
        const committed = yield* Deferred.make<void>();
        yield* Queue.offer(persistQueue, { statements: compiled, committed });
        return committed;
      });
    };

    // -------------------------------------------------------------------------
    // Execution in revm

    const readExecutionHash = evm
      .readStorage({ address: app.address, slots: [executionHashSlot] })
      .pipe(Effect.map((values) => Hex.padLeft(Object.values(values)[0]!, 32)));

    /** Updates the storage view for an execution. */
    const recordExecution = (executeResult: ExecuteResult) => {
      invalidateStorageCache(
        executeResult.slot_writes.map((write) => write.slot),
      );
      for (const preimage of executeResult.keccak_preimages) {
        preimages.add(preimage);
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
        recordExecution(executeResult);
        const accepted = updateMutationToAccepted(
          mutation,
          nextExecutionIndex++,
        );
        yield* emitMutation(accepted);
        return { mutation: accepted, fromExecutionHash, executeResult };
      }).pipe(
        Effect.tapError((error) =>
          Effect.suspend(() =>
            emitMutation(updateMutationToRejected(mutation, error)),
          ),
        ),
      );

    const persistExecutions = (executions: Execution[]) =>
      persist([
        ...insertStorageSlots(app.typewriterSchema, executions),
        ...insertKeccakPreimages(
          app.typewriterSchema,
          executions.flatMap(
            ({ executeResult }) => executeResult.keccak_preimages,
          ),
        ),
      ]);

    const toSettlement = (
      group: Execution[],
      timestamp: bigint,
      committed: Deferred.Deferred<void>,
      contents: Pick<ExecutedSettlement, "batch" | "queueIndexes">,
    ): ExecutedSettlement => ({
      ...contents,
      status: "executed",
      timestamp,
      fromExecutionHash: group[0]!.fromExecutionHash,
      fromExecutionIndex: group[0]!.mutation.executionIndex,
      journalIds: group.map(({ executeResult }) => executeResult.journal_id),
      gasLimit: settlementGasLimit(
        group.map(({ executeResult }) => executeResult),
      ),
      committed,
    });

    // Mutations then enqueues, the order `execute` runs them in.
    const settle = (
      received: { mutation: ReceivedMutation; deferred?: AcceptDeferred }[],
      queueIndexes: bigint[],
      batch?: RuntimeBatch,
    ) =>
      Effect.gen(function* () {
        const block = latest;
        const { timestamp } = block;
        const accepted: (Execution & {
          mutation: AcceptedMutation;
          deferred?: AcceptDeferred;
        })[] = [];
        for (const { mutation, deferred } of received) {
          const result = yield* Effect.result(executeMutation(mutation, block));
          if (Result.isSuccess(result)) {
            accepted.push({ ...result.success, deferred });
          } else if (deferred !== undefined) {
            yield* Deferred.fail(deferred, result.failure);
          }
        }

        const forced: (Execution & { queueIndex: bigint })[] = [];
        for (const queueIndex of queueIndexes) {
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
            block: toBlockParams(block),
          });
          if (
            executeResult.status !== "success" ||
            executeResult.gas_used > SETTLEMENT_GAS
          ) {
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
            discardedQueueIndexes.push(queueIndex);
            continue;
          }
          recordExecution(executeResult);
          forced.push({
            queueIndex,
            mutation: { executionIndex: nextExecutionIndex++ },
            fromExecutionHash,
            executeResult,
          });
        }
        if (accepted.length === 0 && forced.length === 0) return [];

        const rows = yield* persist(
          insertMutations(
            app.mutationSchema,
            accepted.map(({ mutation }) => mutation),
          ),
        );
        const committed = yield* persistExecutions([...accepted, ...forced]);
        const settled: ExecutedSettlement[] = [];
        for (const group of groupByGas<
          (typeof accepted)[number] | (typeof forced)[number]
        >([...accepted, ...forced], ({ executeResult }) => executeResult)) {
          const mutations = group.flatMap((execution) =>
            "queueIndex" in execution ? [] : [execution.mutation],
          );
          let groupBatch: RuntimeBatch | undefined;
          if (mutations.length > 0 && batch !== undefined) {
            groupBatch = Object.assign(batch, { mutations });
            batch = undefined;
          } else if (mutations.length > 0) {
            groupBatch = { status: "accepted", id: nextBatchId++, mutations };
            yield* emitBatch(groupBatch);
          }
          settled.push(
            toSettlement(group, timestamp, committed, {
              batch: groupBatch,
              queueIndexes: group.flatMap((execution) =>
                "queueIndex" in execution ? [execution.queueIndex] : [],
              ),
            }),
          );
        }
        for (const { mutation, deferred } of accepted) {
          if (deferred !== undefined) {
            yield* Deferred.succeed(deferred, { mutation, committed: rows });
          }
        }
        return settled;
      });

    const accept = (
      received: { mutation: ReceivedMutation; deferred: AcceptDeferred }[],
    ) =>
      withStateLock(
        Effect.gen(function* () {
          if (received.length === 0 && pendingQueueIndexes.length === 0) {
            return;
          }
          received.sort(
            (a, b) =>
              (batchOrderByName.get(a.mutation.name) ?? batchOrderByName.size) -
              (batchOrderByName.get(b.mutation.name) ?? batchOrderByName.size),
          );
          const queueIndexes = pendingQueueIndexes;
          pendingQueueIndexes = [];
          settlements.push(...(yield* settle(received, queueIndexes)));
          yield* Queue.offer(sendSignal, undefined);
        }),
      );

    // -------------------------------------------------------------------------
    // Submission

    const sign = (settlement: SigningSettlement) =>
      Effect.gen(function* () {
        const signed = yield* Effect.tryPromise({
          try: () =>
            app.account.signTransaction({
              type: "eip1559",
              chainId: app.chainId,
              nonce: settlement.nonce,
              to: app.address,
              data: settlementCalldata(settlement),
              gas: BigInt(settlement.gasLimit),
              // Room for the base fee to double before it lands.
              maxFeePerGas: 2n * latest.baseFeePerGas + maxPriorityFeePerGas,
              maxPriorityFeePerGas,
            }),
          catch: (cause) => new SignTransactionError({ cause }),
        });
        return signed as Hex.Hex;
      });

    // Sends to every provider, and is sent again until it lands, so a
    // provider that fails or answers wrongly costs nothing.
    const broadcast = (sent: SentSettlement[]) =>
      Effect.gen(function* () {
        for (const settlement of sent) {
          yield* rpc
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
        }
      });

    // One nonce at a time, so a resync stops it before the next.
    const send = Effect.gen(function* () {
      while (true) {
        const settlement = yield* withStateLock(
          Effect.sync(() => {
            if (resyncing) return undefined;
            const next = settlements.find(
              (settlement): settlement is ExecutedSettlement =>
                settlement.status === "executed",
            );
            if (next === undefined) return undefined;
            return updateStatus<ExecutedSettlement, SigningSettlement>(next, {
              status: "signing",
              nonce: nextNonce++,
            });
          }),
        );
        if (settlement === undefined) return;

        yield* Deferred.await(settlement.committed);
        const raw = yield* sign(settlement);
        const sent = updateStatus<SigningSettlement, SentSettlement>(
          settlement,
          {
            status: "sent",
            raw,
            hash: Hash.keccak256(raw),
            sentAt: watched,
            firstSentAt: watched,
          },
        );
        yield* Effect.logDebug("Sending settlement transaction").pipe(
          Effect.annotateLogs({
            nonce: sent.nonce,
            transaction_hash: sent.hash,
            gas_limit: sent.gasLimit,
            mutation_count: sent.batch?.mutations.length ?? 0,
            enqueue_count: sent.queueIndexes.length,
          }),
        );
        yield* broadcast([sent]);
      }
    });

    // -------------------------------------------------------------------------
    // The chain

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

    const include = (
      settlement: SentSettlement,
      transactionIndex: number,
      block: RuntimeBlock,
    ) =>
      Effect.gen(function* () {
        updateStatus<SentSettlement, LandedSettlement>(settlement, {
          status: "included",
          block,
        });
        const { batch } = settlement;
        if (batch === undefined) return;
        const inclusion: Inclusion = {
          blockNumber: block.number,
          blockHash: block.hash,
          blockTimestamp: block.timestamp,
          transactionHash: settlement.hash,
          transactionIndex,
        };
        batch.status = "included";
        for (const mutation of batch.mutations) {
          updateMutationToIncluded(mutation as AcceptedMutation, inclusion);
        }
        block.batches.push(batch);
        yield* Deferred.await(
          yield* persist(
            updateMutationInclusion(
              app.mutationSchema,
              batch.mutations,
              inclusion,
            ),
          ),
        );
      });

    // Once every settlement sent before the first revert is final, the
    // chain is where that settlement started, and it and every later one
    // execute again. A reorg can't undo a final revert.
    const resync = (
      block: { number: bigint; hash: Hex.Hex },
      onchain: Hex.Hex | undefined,
    ) =>
      Effect.gen(function* () {
        if (
          !resyncing ||
          !settlements.every(
            (settlement) =>
              settlement.status === "executed" ||
              (settlement.status === "reverted" &&
                settlement.block.number <= block.number),
          )
        ) {
          return;
        }
        const first = settlements.find(
          (settlement): settlement is LandedSettlement =>
            settlement.status === "reverted",
        )!;
        const from = settlements.indexOf(first);
        const landed = first.block;
        // Only a late landing is fixed by executing again at a newer timestamp.
        if (
          first.timestamp <= landed.timestamp &&
          landed.timestamp - first.timestamp <= BigInt(EXPIRATION_MARGIN)
        ) {
          return yield* new SettlementRevertedError({
            transactionHash: first.hash,
          });
        }
        if (onchain !== first.fromExecutionHash) {
          return yield* new ResyncMismatchError({
            blockNumber: block.number,
            expected: first.fromExecutionHash,
            actual: onchain!,
          });
        }

        const rewound = settlements.slice(from);
        settlements = settlements.slice(0, from);
        yield* evm.revertJournals({
          journal_ids: rewound.flatMap(({ journalIds }) => journalIds),
        });
        invalidateStorageCache();
        // TODO(kyle) `execute` already returned the old execution index.
        nextExecutionIndex = first.fromExecutionIndex;
        yield* persist(
          deleteExecutionsFrom(
            app.mutationSchema,
            app.typewriterSchema,
            nextExecutionIndex,
          ),
        );

        pendingQueueIndexes = [
          ...discardedQueueIndexes,
          ...pendingQueueIndexes,
        ];
        discardedQueueIndexes = [];
        for (const { batch, queueIndexes } of rewound) {
          const received = (batch?.mutations ?? []).map((mutation) => ({
            mutation: toUnexecuted(mutation as AcceptedMutation),
          }));
          settlements.push(...(yield* settle(received, queueIndexes, batch)));
        }
        if (pendingQueueIndexes.length > 0) {
          yield* Queue.offer(acceptSignal, undefined);
        }
        yield* Effect.logWarning("Executed settlements again").pipe(
          Effect.annotateLogs({
            from_execution_index: first.fromExecutionIndex,
            rewound_count: rewound.length,
            settlement_count: settlements.length - from,
          }),
        );
        resyncing = false;
        yield* Queue.offer(sendSignal, undefined);
      });

    // Ahead of `land`, which takes blocks one at a time.
    const sentIn = (block: FetchedBlock) => {
      const sentByHash = new Map(
        settlements
          .filter(
            (settlement): settlement is SentSettlement =>
              settlement.status === "sent",
          )
          .map((settlement) => [settlement.hash, settlement]),
      );
      return block.transactions.flatMap((hash) => sentByHash.get(hash) ?? []);
    };

    const requestLanded = (block: FetchedBlock) =>
      Effect.gen(function* () {
        const landed = sentIn(block);
        const receipts = yield* Effect.forEach(
          landed,
          (settlement) => requestReceipt(settlement.hash, block),
          { concurrency: "unbounded" },
        );
        return { landed, receipts };
      });

    type LandedRequest = Effect.Success<ReturnType<typeof requestLanded>>;
    /** Each block's landed settlements, requested once the watch has its transactions. */
    const landedRequests = new Map<
      Hex.Hex,
      { number: bigint; landed: Deferred.Deferred<LandedRequest> }
    >();

    // Records where our transactions in `block` landed, in order.
    const land = (block: LocalBlock) =>
      Effect.gen(function* () {
        const prefetched = landedRequests.get(block.hash);
        landedRequests.delete(block.hash);
        const requested =
          prefetched === undefined
            ? undefined
            : yield* Deferred.await(prefetched.landed);
        // A removed block's settlements are sent again after `requested`.
        const { landed, receipts } =
          sentIn(block).length === requested?.landed.length
            ? requested
            : yield* requestLanded(block);
        // The watch removes the block.
        if (receipts.includes(undefined)) return;

        yield* withStateLock(
          Effect.gen(function* () {
            const runtimeBlock: RuntimeBlock = {
              status: "included",
              number: block.number,
              hash: block.hash,
              timestamp: block.timestamp,
              batches: [],
            };
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
                if (!resyncing) {
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
                resyncing = true;
                continue;
              }
              if (resyncing) {
                return yield* new SettlementAfterRevertError({
                  transactionHash: receipt.transactionHash,
                });
              }
              yield* include(
                settlement,
                receipt.transactionIndex,
                runtimeBlock,
              );
            }
            if (receipts.some((receipt) => receipt!.status === "success")) {
              yield* emitBlock(runtimeBlock);
            }
          }),
        );
      });

    // A reorg replaced `block`. Its settlements are sent again as signed, and
    // land with the same result, since each pins its timestamp.
    const unland = (block: LocalBlock) =>
      withStateLock(
        Effect.gen(function* () {
          const removed = settlements.filter(
            (settlement): settlement is LandedSettlement =>
              (settlement.status === "included" ||
                settlement.status === "reverted") &&
              settlement.block.hash === block.hash,
          );
          if (removed.length === 0) return 0;
          const runtimeBlock = removed[0]!.block;
          const included = removed.some(({ status }) => status === "included");
          for (const settlement of removed) {
            delete (settlement as Partial<LandedSettlement>).block;
            const sent = updateStatus<LandedSettlement, SentSettlement>(
              settlement,
              { status: "sent" },
            );
            sent.sentAt = 0n;
            sent.firstSentAt = watched;
          }
          resyncing = settlements.some(({ status }) => status === "reverted");
          yield* Queue.offer(sendSignal, undefined);
          if (!included) return removed.length;

          const mutations = runtimeBlock.batches.flatMap((batch) => {
            batch.status = "accepted";
            return batch.mutations.map((mutation) =>
              updateMutationToUnincluded(mutation as IncludedMutation),
            );
          });
          yield* Deferred.await(
            yield* persist(
              updateMutationInclusion(app.mutationSchema, mutations, undefined),
            ),
          );
          const { number, hash, timestamp } = runtimeBlock;
          yield* emit("block", blockListeners, {
            status: "removed",
            number,
            hash,
            timestamp,
          } as BlockEvent<"fifo" | "batch">);
          return removed.length;
        }),
      );

    const rebroadcast = (block: LocalBlock) =>
      Effect.gen(function* () {
        const due: SentSettlement[] = [];
        for (const settlement of settlements) {
          if (
            settlement.status !== "sent" ||
            block.number < settlement.sentAt + REBROADCAST_BLOCKS
          ) {
            continue;
          }
          if (block.number - settlement.firstSentAt > STUCK_BLOCKS) {
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
            settlement.sentAt = block.number;
            continue;
          }
          settlement.sentAt = block.number;
          due.push(settlement);
        }
        if (due.length > 0) yield* broadcast(due);
      });

    const finalize = (
      finalized: { number: bigint; hash: Hex.Hex },
      onchain: Hex.Hex | undefined,
    ) =>
      withStateLock(
        Effect.gen(function* () {
          const final = settlements.filter(
            (settlement): settlement is LandedSettlement =>
              settlement.status === "included" &&
              settlement.block.number <= finalized.number,
          );
          if (final.length > 0) {
            yield* evm.pruneJournals({
              journal_ids: final.flatMap(({ journalIds }) => journalIds),
            });
          }
          const isFinal = new Set<RuntimeSettlement>(final);
          settlements = settlements.filter(
            (settlement) => !isFinal.has(settlement),
          );

          for (const block of new Set(final.map(({ block }) => block))) {
            block.status = "finalized";
            for (const batch of block.batches) {
              batch.status = "finalized";
              for (const mutation of batch.mutations) {
                (mutation as IncludedMutation).status = "finalized";
              }
            }
            yield* emitBlock(block);
          }
          yield* resync(finalized, onchain);
        }),
      );

    // Every enqueue takes a queue index onchain, so revm replays each one
    // with its bytes, once its block is final, so no reorg undoes it. The
    // next batch force-executes it.
    const replayEnqueues = (finalized: bigint) =>
      withStateLock(
        Effect.gen(function* () {
          const final = unfinalizedEnqueues.filter(
            ({ number }) => number <= finalized,
          );
          unfinalizedEnqueues = unfinalizedEnqueues.filter(
            ({ number }) => number > finalized,
          );
          for (const block of final) {
            for (const log of block.logs) {
              const queued = decodeForceInclusionQueued(log);
              const executeResult = yield* evm.execute({
                from: "0x0000000000000000000000000000000000000000",
                to: app.address,
                data: encodeEnqueueCalldata(queued),
                // An enqueue records its block's timestamp.
                block: toBlockParams(block),
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
              // The enqueue is already onchain, so nothing rewinds it.
              yield* evm.pruneJournals({
                journal_ids: [executeResult.journal_id],
              });
              invalidateStorageCache(
                executeResult.slot_writes.map((write) => write.slot),
              );
              pendingQueueIndexes.push(queued.index);
              yield* Queue.offer(acceptSignal, undefined);
            }
          }
        }),
      );

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
          if (message._tag === "Fetched") {
            const { number, hash, timestamp, baseFeePerGas } = message.block;
            if (number > latest.number) {
              latest = { number, timestamp, baseFeePerGas };
            }
            if (
              landedRequests.has(hash) ||
              sentIn(message.block).length === 0
            ) {
              return;
            }
            const landed = yield* Deferred.make<LandedRequest>();
            landedRequests.set(hash, { number, landed });
            yield* Deferred.into(requestLanded(message.block), landed).pipe(
              Effect.forkIn(scope),
            );
            return;
          }
          if (message._tag === "Finalized") {
            for (const [hash, { number }] of landedRequests) {
              if (number <= message.block.number) landedRequests.delete(hash);
            }
            // Requested outside the state lock, which `accept` waits on.
            const onchain = resyncing
              ? yield* untilSuccess(
                  requestExecutionHash(app.address, message.block.hash).pipe(
                    Effect.provideService(Rpc, rpc),
                  ),
                )
              : undefined;
            yield* replayEnqueues(message.block.number);
            return yield* finalize(message.block, onchain);
          }
          if (message._tag === "Removed") {
            const { hash } = message.block;
            unfinalizedEnqueues = unfinalizedEnqueues.filter(
              (block) => block.hash !== hash,
            );
            yield* Effect.logInfo("Removed reorged block").pipe(
              Effect.annotateLogs({
                block_number: message.block.number,
                block_hash: hash,
                settlement_count: yield* unland(message.block),
              }),
            );
            return;
          }

          if (!refreshingPriorityFee) {
            refreshingPriorityFee = true;
            yield* Effect.gen(function* () {
              maxPriorityFeePerGas = yield* requestPriorityFee;
            }).pipe(
              Effect.catch((error) =>
                Effect.logDebug("Failed to refresh the priority fee", error),
              ),
              Effect.ensuring(
                Effect.sync(() => {
                  refreshingPriorityFee = false;
                }),
              ),
              Effect.forkIn(scope),
            );
          }
          watched = message.block.number;
          if (message.block.logs.length > 0) {
            unfinalizedEnqueues.push(message.block);
          }
          yield* land(message.block);
          yield* rebroadcast(message.block);
        }),
      ),
      Effect.provideService(Rpc, rpc),
    );

    // -------------------------------------------------------------------------
    // Programs

    const acceptProgram =
      app.sequencing.order === "batch"
        ? Effect.sleep(Duration.millis(app.sequencing.batchIntervalMs)).pipe(
            Effect.andThen(
              Effect.repeat(
                Queue.clear(receivedMutationQueue).pipe(Effect.flatMap(accept)),
                Schedule.fixed(Duration.millis(app.sequencing.batchIntervalMs)),
              ),
            ),
          )
        : Effect.forever(
            Queue.take(acceptSignal).pipe(
              Effect.andThen(Queue.clear(receivedMutationQueue)),
              Effect.flatMap(accept),
            ),
          );

    const sendProgram = Effect.forever(
      Queue.take(sendSignal).pipe(Effect.andThen(send)),
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
      [acceptProgram, sendProgram, persistProgram, watchProgram],
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

        const deferred = yield* Deferred.make<
          { mutation: AcceptedMutation; committed: Deferred.Deferred<void> },
          ExecuteMutationError
        >();
        const acceptStartedAt = yield* startTimer;

        yield* Queue.offer(receivedMutationQueue, {
          mutation: runtimeMutation,
          deferred,
        });
        yield* Queue.offer(acceptSignal, undefined);

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
