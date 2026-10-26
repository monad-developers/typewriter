import {
  Data,
  Deferred,
  Duration,
  Effect,
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
  ContractFunctionRevertedError,
  decodeEventLog,
  formatTransactionReceipt,
  getAbiItem,
  parseTransaction,
  RawContractError,
  toEventSelector,
} from "viem";
import type {
  MutationsConfig,
  SequencingConfig,
  StorageConfig,
  TypewriterApp,
  TypewriterManifest,
} from "./config";
import { Database, type Db, type DbError } from "./db";
import { deploymentLockKey, type MigrationError, migrate } from "./db-migrate";
import {
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
import { durationMs, loggerLayer, startTimer } from "./logger";
import { Rpc, type RpcError } from "./rpc";
import {
  type NoDataReturnedError,
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
import { type LocalLog, makeWatch, type WatchError } from "./watch";

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

/** `execute` got a mutation name that the app does not define. */
export class UnknownMutationError extends Data.TaggedError(
  "UnknownMutationError",
)<{
  readonly mutation: string;
}> {}

export class SignTransactionError extends Data.TaggedError(
  "SignTransactionError",
)<{
  readonly cause: unknown;
}> {}

/** Each part of the program runs forever, so it stops only on a bug. */
export class ProgramStoppedError extends Data.TaggedError(
  "ProgramStoppedError",
) {}

/** A settlement transaction reverted when simulated in revm. */
export class SettlementSimulationRevertedError extends Data.TaggedError(
  "SettlementSimulationRevertedError",
)<Revert> {}

/** A settlement transaction was mined but reverted onchain. */
export class SettlementRevertedError extends Data.TaggedError(
  "SettlementRevertedError",
)<{
  readonly message: string;
  readonly transactionHash: Hex.Hex;
}> {}

/** Why `execute` did not accept a mutation. */
export type ExecuteError = UnknownMutationError | ExecuteMutationError;

export type ProgramError =
  | WatchError
  | DbError
  | EvmError
  | SettlementSimulationRevertedError
  | SettlementRevertedError
  | SignTransactionError
  | ProgramStoppedError;

export type CreateTypewriterError =
  | DbError
  | RpcError
  | NoDataReturnedError
  | MigrationError
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

/**
 * The 64-byte keccak256 preimages of an execution: the inputs that hash a
 * mapping key with its slot. Shorter preimages give dynamic array data slots,
 * which enumeration does not need. The EVM writes them as lowercase hex.
 */
function mappingPreimages(executeResult: ExecuteResult): readonly Hex.Hex[] {
  return executeResult.keccak_preimages
    .map(({ preimage }) => preimage)
    .filter((preimage) => Hex.size(preimage) === 64);
}

export class EncodeMutationError extends Data.TaggedError(
  "EncodeMutationError",
)<{
  readonly mutation: ReceivedMutation | EnqueuedMutation;
  readonly cause: unknown;
}> {}

/** A mutation reverted when executed in revm. */
export class MutationRevertedError extends Data.TaggedError(
  "MutationRevertedError",
)<Revert> {}

export type ExecuteMutationError =
  | EncodeMutationError
  | EvmError
  | MutationRevertedError;

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

    const executeStartedAtMs = startTimer();
    const executeResult = yield* params.evm.execute({
      from: params.app.account.address,
      to: params.app.address,
      data: mutationCalldata,
    });

    if (executeResult.success === false) {
      return yield* new MutationRevertedError(
        decodeRevert(
          params.app.abi,
          executeResult.revert_data,
          "revm execute reverted",
        ),
      );
    }

    const acceptedMutation = updateMutationToAccepted(params.mutation, {
      executionIndex: params.executionIndex,
      journalId: executeResult.journal_id!,
    });

    yield* Effect.logDebug("executed mutation").pipe(
      Effect.annotateLogs({
        executionIndex: acceptedMutation.executionIndex,
        name: acceptedMutation.name,
        success: executeResult.success,
        slotWriteCount: executeResult.slot_writes.length,
        duration: durationMs(executeStartedAtMs),
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

    return yield* params.evm.execute({
      from: "0x0000000000000000000000000000000000000000",
      to: params.app.address,
      data: enqueueCalldata,
    });
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
      `unknown mutation tag in ForceInclusionQueued event: ${forceInclusionLog.mutation}`,
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
  readonly message: string;
  readonly data: Hex.Hex | undefined;
  /** The custom error's name, or `Error`/`Panic` for the built-in ones. */
  readonly errorName: string | undefined;
  readonly args: readonly unknown[] | undefined;
  readonly cause: ContractFunctionRevertedError;
};

function decodeRevert(
  abi: Abi,
  data: Hex.Hex | undefined,
  message: string,
): Revert {
  const cause = new ContractFunctionRevertedError({
    abi,
    data,
    functionName: "execute",
    message,
    cause: new RawContractError({ data, message }),
  });
  const errorName = cause.data?.errorName;
  return {
    message: errorName === undefined ? message : `${message}: ${errorName}`,
    data,
    errorName,
    args: cause.data?.args,
    cause,
  };
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
  DbError | EvmError,
  Scope.Scope
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

    const evm = yield* createEVM();

    if (code === "0x") {
      yield* Effect.logWarning(
        `no contract code at app.address=${app.address}; ` +
          "revm code load skipped - runtime will continue but revm has no contract bytecode",
      );
      yield* evm.init({
        chain_id: app.chainId,
        accounts: {
          [app.address]: {
            storage: initialAccountStorage,
          },
        },
      });
    } else {
      yield* evm.init({
        chain_id: app.chainId,
        accounts: {
          [app.address]: {
            code,
            storage: initialAccountStorage,
          },
        },
      });
    }

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

    const lockLost = yield* db.lock(
      deploymentLockKey(app.chainId, app.address),
      DEPLOYMENT_LOCK_TIMEOUT_MS,
    );

    const code = yield* rpc.request({
      method: "eth_getCode",
      params: [app.address, "latest"],
    });
    let nextExecutionIndex = yield* requestExecutionIndex(app.address);
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

    const watch = yield* makeWatch({
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
      deferred: Deferred.Deferred<AcceptedMutation, ExecuteMutationError>;
    }>();
    const enqueuedMutationsQueue = yield* Queue.unbounded<EnqueuedMutation>();
    const acceptedBatchesQueue = yield* Queue.unbounded<number>();
    yield* Scope.addFinalizer(scope, Queue.shutdown(receivedMutationQueue));
    yield* Scope.addFinalizer(scope, Queue.shutdown(enqueuedMutationsQueue));
    yield* Scope.addFinalizer(scope, Queue.shutdown(acceptedBatchesQueue));

    const withSpeculativeStateLock = Semaphore.withPermits(
      Semaphore.makeUnsafe(1),
      1,
    );
    const withSubmitLock = Semaphore.withPermits(Semaphore.makeUnsafe(1), 1);

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

    const emitMutation = (event: MutationEvent) => {
      for (const cb of mutationListeners) {
        try {
          cb(event);
        } catch {}
      }
    };

    const emitBatch = (event: BatchEvent) => {
      if (app.sequencing.order !== "batch") return;
      for (const cb of batchListeners) {
        try {
          cb(event);
        } catch {}
      }
    };

    const emitBlock = (block: RuntimeBlock<"batch">) => {
      const event =
        app.sequencing.order === "fifo"
          ? fifoBlockToEvent(batchBlockToFifoBlock(block))
          : batchBlockToEvent(block);
      for (const cb of blockListeners) {
        try {
          cb(event as BlockEvent<"fifo" | "batch">);
        } catch {}
      }
    };

    // Executes a mutation against speculative state and updates in-memory
    // bookkeeping, but performs no database writes. Persistence is batched by
    // the caller (`acceptBatch`, `submit`, and `watch`) so many mutations share
    // a single set of insert statements.
    function acceptMutation(
      mutation: ReceivedMutation | EnqueuedMutation,
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
        const { executeResult, mutation: acceptedMutation } =
          yield* executeMutation({
            app,
            evm,
            mutation,
            executionIndex: nextExecutionIndex,
          }).pipe(
            Effect.tapError((error) => {
              const rejectedMutation = updateMutationToRejected(mutation, {
                error,
              });

              emitMutation(mutationToEvent(rejectedMutation));

              return Effect.void;
            }),
          );

        nextExecutionIndex++;

        invalidateStorageCache(
          executeResult.slot_writes.map((write) => write.slot),
        );

        const newPreimages: Hex.Hex[] = [];
        for (const preimage of mappingPreimages(executeResult)) {
          if (preimages.has(preimage)) continue;
          preimages.add(preimage);
          newPreimages.push(preimage);
        }

        emitMutation(mutationToEvent(acceptedMutation));

        return {
          mutation: acceptedMutation,
          executeResult,
          preimages: newPreimages,
        };
      });
    }

    const acceptBatch = (
      submittedMutations: {
        mutation: ReceivedMutation;
        deferred: Deferred.Deferred<AcceptedMutation, ExecuteMutationError>;
      }[],
    ) =>
      withSpeculativeStateLock(
        Effect.gen(function* () {
          const batchStartedAtMs = startTimer();

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
            deferred: Deferred.Deferred<AcceptedMutation, ExecuteMutationError>;
          }[] = [];

          for (const { mutation, deferred } of submittedMutations) {
            const result = yield* Effect.result(acceptMutation(mutation));
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

          yield* Effect.logDebug("batched mutations").pipe(
            Effect.annotateLogs({
              id: batch.id,
              mutationCount: batch.mutations.length,
              duration: durationMs(batchStartedAtMs),
            }),
          );

          batchesById.set(batch.id, batch);

          emitBatch(batchToEvent(batch));

          const persistStartedAtMs = startTimer();
          yield* db.transaction((tx) =>
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

          for (const { mutation, deferred } of acceptedMutations) {
            yield* Deferred.succeed(deferred, mutation);
          }

          yield* Effect.logDebug("persisted accepted mutations").pipe(
            Effect.annotateLogs({
              mutationCount: acceptedMutations.length,
              duration: durationMs(persistStartedAtMs),
            }),
          );

          yield* Queue.offer(acceptedBatchesQueue, batch.id);
        }),
      );

    const submit = Effect.gen(function* () {
      const simulation = yield* withSpeculativeStateLock(
        Effect.gen(function* () {
          const batchIds = yield* Queue.clear(acceptedBatchesQueue);
          const enqueuedMutations = yield* Queue.clear(enqueuedMutationsQueue);
          if (batchIds.length === 0 && enqueuedMutations.length === 0) {
            return undefined;
          }

          const batches = batchIds.map((id) => batchesById.get(id)!);

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
              // TODO(kyle) how to handle failed enqueue.
            }
          }

          const acceptedForceIncludedMutations = acceptedEnqueuedMutations.map(
            ({ mutation }) => mutation,
          );

          if (acceptedEnqueuedMutations.length > 0) {
            yield* db.transaction((tx) =>
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
                  acceptedEnqueuedMutations.flatMap((entry) => entry.preimages),
                );
              }),
            );
          }

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
            acceptedForceIncludedMutations.map(({ queueIndex }) => queueIndex),
          );

          const simulationStartedAtMs = startTimer();
          const simulateResult = yield* evm.simulate({
            from: app.account.address,
            to: app.address,
            data: calldata,
            journal_ids: speculativeJournalIds,
          });
          const duration = durationMs(simulationStartedAtMs);
          if (simulateResult.success === false) {
            return yield* new SettlementSimulationRevertedError(
              decodeRevert(
                app.abi,
                simulateResult.revert_data,
                "revm simulate reverted",
              ),
            );
          }

          yield* Effect.logDebug("simulated transaction submission").pipe(
            Effect.annotateLogs({
              nonce,
              gasLimit: simulateResult.gas_limit,
              batchCount: batches.length,
              mutationCount: speculativeJournalIds.length,
              duration,
            }),
          );

          return {
            batches,
            acceptedForceIncludedMutations,
            calldata,
            simulateResult,
          };
        }),
      );

      if (simulation === undefined) return;

      const {
        batches,
        acceptedForceIncludedMutations,
        calldata,
        simulateResult,
      } = simulation;

      const transactionStartedAtMs = startTimer();

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
        Effect.retry({ times: SUBMIT_RETRY_TIMES }),
        Effect.map(formatTransactionReceipt),
      );

      nonce += 1;

      if (receipt.status === "reverted") {
        return yield* new SettlementRevertedError({
          message: `settlement transaction reverted onchain: ${receipt.transactionHash}`,
          transactionHash: receipt.transactionHash,
        });
      }
      const duration = durationMs(transactionStartedAtMs);

      yield* Effect.logDebug("submitted transaction").pipe(
        Effect.annotateLogs({
          transactionHash: receipt.transactionHash,
          blockHash: receipt.blockHash,
          blockNumber: receipt.blockNumber,
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

      yield* db.transaction((tx) =>
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

      emitBlock(runtimeBlock);
      for (const batch of batches) {
        emitBatch(batchToEvent(batch));
        for (const mutation of batch.mutations) {
          emitMutation(mutationToEvent(mutation));
        }
      }
      for (const mutation of forceIncludedMutations) {
        emitMutation(mutationToEvent(mutation));
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

            for (const log of message.block.logs) {
              // TODO(kyle) check the log's queue index against the length of
              // the queue in revm. A missed log shifts every later enqueued
              // mutation, so `execute` runs a different queued mutation than
              // the one revm accepted, and the settlement reverts onchain.
              const enqueuedMutation = decodeEnqueuedMutation({ app, log });

              const executeResult = yield* withSpeculativeStateLock(
                enqueueMutation({ app, evm, mutation: enqueuedMutation }),
              );

              if (executeResult.success === false) {
                continue;
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

              emitBlock(block);

              for (const batch of block.batches) {
                emitBatch(batchToEvent(batch));
                for (const mutation of batch.mutations) {
                  emitMutation(mutationToEvent(mutation));
                }
              }
              for (const mutation of block.forceIncludedMutations) {
                emitMutation(mutationToEvent(mutation));
              }
            }
            unfinalizedBlocks = unfinalizedBlocks.filter(
              (block) => block.status !== "finalized",
            );
          }),
        ),
      );
    }).pipe(Effect.withLogSpan("watch"));

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

    const program = Effect.all(
      [batchProgram, submitProgram, watchProgram, watch.program],
      { concurrency: "unbounded" },
    ).pipe(
      Effect.andThen(Effect.fail(new ProgramStoppedError())),
      Effect.raceFirst(lockLost),
      Effect.provide(loggerLayer),
    );

    function execute(
      mutation: RuntimeExecuteInput,
    ): Effect.Effect<TypewriterMutationResult, ExecuteError> {
      return Effect.gen(function* () {
        const resolvedMutation = resolveMutationConfig(app, mutation.name);
        if (resolvedMutation === undefined) {
          return yield* Effect.fail(
            new UnknownMutationError({ mutation: mutation.name }),
          );
        }

        const runtimeMutation = {
          name: resolvedMutation.name,
          params: mutation.params,
          authorization: mutation.authorization,
          status: "received",
          config: resolvedMutation.config,
        } as const satisfies ReceivedMutation;

        yield* Effect.logDebug("received mutation").pipe(
          Effect.annotateLogs({
            name: runtimeMutation.name,
            params: runtimeMutation.params,
          }),
        );

        emitMutation(mutationToEvent(runtimeMutation));

        const deferred = yield* Deferred.make<
          AcceptedMutation,
          ExecuteMutationError
        >();
        const acceptStartedAtMs = startTimer();

        yield* Queue.offer(receivedMutationQueue, {
          mutation: runtimeMutation,
          deferred,
        });

        const acceptedMutation = yield* Deferred.await(deferred).pipe(
          Effect.tapError((error) =>
            Effect.logError(error).pipe(
              Effect.annotateLogs({
                message: "rejected mutation",
                name: runtimeMutation.name,
                params: runtimeMutation.params,
              }),
            ),
          ),
        );

        yield* Effect.logDebug("accepted mutation").pipe(
          Effect.annotateLogs({
            executionIndex: acceptedMutation.executionIndex,
            name: runtimeMutation.name,
            params: runtimeMutation.params,
            duration: durationMs(acceptStartedAtMs),
          }),
        );

        return { executionIndex: acceptedMutation.executionIndex };
      }).pipe(Effect.provide(loggerLayer));
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
  }).pipe(
    Effect.tapError((error) => Effect.logError(error)),
    Effect.provide(loggerLayer),
  );
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
