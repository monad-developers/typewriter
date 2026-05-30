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
import {
  createEVM,
  type EVM,
  type EvmError,
  type ExecuteResult,
} from "ffca-evm";
import { Hex } from "ox";
import { createStorageProxy, type StorageProxy } from "storage-layout";
import {
  ContractFunctionRevertedError,
  decodeEventLog,
  formatTransactionReceipt,
  parseTransaction,
  RawContractError,
} from "viem";
import { Database } from "./db";
import {
  insertKnownPaths,
  insertMutations,
  insertSlotWritesMany,
  selectAccountStorage,
  selectKnownPaths,
  selectNextMutationId,
  updateMutationsLifecycle,
} from "./db-query";
import {
  decodeMutationCalldata,
  decodeSignatureCalldata,
  encodeBatchArg,
  encodeEnqueueCalldata,
  encodeExecuteCalldata,
  FFCA_ABI,
} from "./encoding";
import type {
  BatchListener,
  BlockListener,
  InternalRuntimeFFCA,
  MutationListener,
} from "./ffca";
import type { InternalApp } from "./internal";
import { durationMs, loggerLayer, startTimer } from "./logger";
import { Rpc } from "./rpc";
import { requestBlock } from "./rpc-request";
import type {
  AcceptedMutation,
  BatchEvent,
  BlockEvent,
  EnqueuedMutation,
  FFCAMutation,
  FFCAMutationResult,
  MutationEvent,
  ReceivedMutation,
  RejectedMutation,
  RuntimeBatch,
  RuntimeBlock,
  RuntimeMutation,
  SubmittedMutation,
} from "./types";
import { dedupe } from "./utils";
import type { LocalLog } from "./watch";
import { Watch } from "./watch";

const FIFO_BATCH_INTERVAL_MS = 4;

export function updateMutationToAccepted(
  mutation: ReceivedMutation | EnqueuedMutation,
  params: {
    journalId: number;
    isForceInclusion: boolean;
    resolution?: unknown;
  },
): AcceptedMutation {
  const acceptedMutation = mutation as unknown as AcceptedMutation;
  acceptedMutation.status = "accepted";
  acceptedMutation.journalId = params.journalId;
  acceptedMutation.isForceInclusion = params.isForceInclusion;
  acceptedMutation.resolution = params.resolution;
  return acceptedMutation;
}

export function updateMutationToRejected(
  mutation: ReceivedMutation | EnqueuedMutation,
  params: { error: unknown },
): RejectedMutation {
  const rejectedMutation = mutation as unknown as RejectedMutation;
  rejectedMutation.status = "rejected";
  rejectedMutation.isForceInclusion = false;
  rejectedMutation.error = params.error;
  return rejectedMutation;
}

export function updateMutationToIncluded(
  mutation: AcceptedMutation,
): SubmittedMutation {
  const includedMutation = mutation as unknown as SubmittedMutation;
  includedMutation.status = "included";
  return includedMutation;
}

export function updateMutationToSafe(
  mutation: SubmittedMutation,
): SubmittedMutation {
  const safeMutation = mutation as SubmittedMutation;
  safeMutation.status = "safe";
  return safeMutation;
}

export function updateMutationToFinalized(
  mutation: SubmittedMutation,
): SubmittedMutation {
  const finalizedMutation = mutation as SubmittedMutation;
  finalizedMutation.status = "finalized";
  return finalizedMutation;
}

export function mutationToEvent(mutation: RuntimeMutation): MutationEvent {
  const { config: _config, ...event } = mutation;
  return { ...event };
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
    batches: block.batches.map(batchToEvent) as Exclude<
      BatchEvent,
      { status: "accepted" }
    >[],
    forceIncludedMutations: block.forceIncludedMutations.map(
      mutationToEvent,
    ) as BlockEvent<"batch">["forceIncludedMutations"],
  };
}

async function resolveMutation(
  mutation: ReceivedMutation,
  state: unknown,
): Promise<unknown> {
  if ("resolve" in mutation.config) {
    return mutation.config.resolve({
      state,
      args: mutation.args,
      signature: mutation.signature,
    });
  }
  return undefined;
}

async function registerKnownPaths(
  mutation: AcceptedMutation,
): Promise<readonly string[]> {
  if (mutation.config.registerMappingKeys === undefined) return [];
  return mutation.config.registerMappingKeys({
    args: mutation.args,
    signature: mutation.signature,
    resolution: mutation.resolution,
  });
}

export class ResolveMutationError extends Data.TaggedError(
  "ResolveMutationError",
)<{
  readonly mutation: ReceivedMutation | EnqueuedMutation;
  readonly cause: unknown;
}> {}

export class RegisterKnownPathsError extends Data.TaggedError(
  "RegisterKnownPathsError",
)<{
  readonly mutation: ReceivedMutation | EnqueuedMutation;
  readonly cause: unknown;
}> {}

export class EncodeMutationError extends Data.TaggedError(
  "EncodeMutationError",
)<{
  readonly mutation: ReceivedMutation | EnqueuedMutation;
  readonly cause: unknown;
}> {}

export function executeMutation(params: {
  app: InternalApp;
  state: unknown;
  evm: EVM;
  mutation: ReceivedMutation | EnqueuedMutation;
}): Effect.Effect<
  {
    mutation: AcceptedMutation;
    executeResult: ExecuteResult;
    knownPaths: readonly string[];
  },
  | ResolveMutationError
  | RegisterKnownPathsError
  | EncodeMutationError
  | EvmError
  | ContractFunctionRevertedError
> {
  return Effect.gen(function* () {
    let resolution: unknown;
    if (params.mutation.status === "enqueued") {
      resolution = params.mutation.resolution;
    } else {
      const mutation = params.mutation;
      resolution = yield* Effect.tryPromise({
        try: () => resolveMutation(mutation, params.state),
        catch: (cause) =>
          new ResolveMutationError({
            mutation,
            cause,
          }),
      });
    }

    const acceptedMutation = updateMutationToAccepted(params.mutation, {
      journalId: -1,
      isForceInclusion: params.mutation.status === "enqueued",
      resolution,
    });

    const knownPaths = yield* Effect.tryPromise({
      try: () => registerKnownPaths(acceptedMutation),
      catch: (cause) =>
        new RegisterKnownPathsError({
          mutation: params.mutation,
          cause,
        }),
    });

    const mutationCalldata = yield* Effect.try({
      try: () =>
        params.mutation.status === "enqueued"
          ? encodeExecuteCalldata([], [params.mutation.queueIndex])
          : encodeExecuteCalldata(
              [encodeBatchArg(params.app.signature.params, [acceptedMutation])],
              [],
            ),
      catch: (cause) =>
        new EncodeMutationError({ mutation: params.mutation, cause }),
    });

    const executeStartedAtMs = startTimer();
    const executeResult = yield* params.evm.execute({
      from: params.app.account.address,
      to: params.app.address,
      data: mutationCalldata,
    });

    yield* Effect.logDebug("executed mutation").pipe(
      Effect.annotateLogs({
        id: acceptedMutation.id,
        name: acceptedMutation.name,
        success: executeResult.success,
        slotWriteCount: executeResult.slot_writes.length,
        knownPathCount: knownPaths.length,
        duration: durationMs(executeStartedAtMs),
      }),
    );

    if (executeResult.success === false) {
      return yield* Effect.fail(
        createRevmRevertError(executeResult.revert_data),
      );
    }

    acceptedMutation.journalId = executeResult.journal_id!;

    return {
      mutation: acceptedMutation,
      executeResult,
      knownPaths,
    };
  });
}

export function enqueueMutation(params: {
  app: InternalApp;
  evm: EVM;
  mutation: EnqueuedMutation;
}): Effect.Effect<ExecuteResult, EvmError> {
  return Effect.gen(function* () {
    const enqueueCalldata = encodeEnqueueCalldata(
      params.app.signature.params,
      params.mutation,
    );

    return yield* params.evm.execute({
      from: "0x0000000000000000000000000000000000000000",
      to: params.app.address,
      data: enqueueCalldata,
    });
  });
}

type RawSlotMap = { [slot: Hex.Hex]: Hex.Hex };
const SLOT_CACHE_MAX_ENTRIES = 200_000;

export function decodeEnqueuedMutation(params: {
  app: InternalApp;
  log: LocalLog;
  id: number;
}): EnqueuedMutation {
  const forceInclusionLog = decodeEventLog({
    abi: FFCA_ABI,
    eventName: "ForceInclusionQueued",
    // @ts-expect-error viem's decoded log topic tuple type is narrower than LocalLog's runtime topics.
    topics: params.log.topics,
    data: params.log.data,
    strict: true,
  }).args;

  const [mutationName, mutationConfig] = Object.entries(
    params.app.mutations,
  ).find(
    ([_, mutationConfig]) => mutationConfig.tag === forceInclusionLog.mutation,
  )!;

  return {
    status: "enqueued",
    id: params.id,
    name: mutationName,
    config: mutationConfig,
    signature: decodeSignatureCalldata(
      params.app.signature.params,
      forceInclusionLog.signatureData,
    ),
    isForceInclusion: true,
    queueIndex: forceInclusionLog.index,
    ...decodeMutationCalldata(mutationConfig, forceInclusionLog.mutationData),
  };
}

export function createRevmRevertError(
  data: Hex.Hex | undefined,
  message = "revm execute reverted",
): ContractFunctionRevertedError {
  return new ContractFunctionRevertedError({
    abi: FFCA_ABI,
    data,
    functionName: "execute",
    message,
    cause: new RawContractError({ data, message }),
  });
}

export function createRuntimeState(app: InternalApp): Effect.Effect<
  {
    evm: EVM;
    state: StorageProxy<InternalApp["storageLayout"], true>;
    knownPaths: string[];
    invalidateStorageCache: (slots?: readonly Hex.Hex[]) => void;
  },
  unknown,
  Database | Rpc | Scope.Scope
> {
  return Effect.gen(function* () {
    const db = yield* Database;
    const rpc = yield* Rpc;

    const { initialAccountStorage, knownPaths } = yield* db.transaction((tx) =>
      Effect.gen(function* () {
        const knownPaths = yield* selectKnownPaths(tx, app.schema);
        const initialAccountStorage = yield* selectAccountStorage(
          tx,
          app.schema,
        );

        return {
          knownPaths,
          initialAccountStorage,
        };
      }),
    );

    const evm = yield* createEVM();
    const code = yield* rpc.request({
      method: "eth_getCode",
      params: [app.address, "latest"],
    });

    if (code === undefined || code === "0x") {
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

    let slotCache: RawSlotMap = {};
    const invalidateStorageCache = (slots?: readonly Hex.Hex[]) => {
      if (slots === undefined) {
        slotCache = {};
        return;
      }

      for (const slot of slots) {
        delete slotCache[slot];
      }
    };

    const state = createStorageProxy(
      app.storageLayout,
      async (slots) => {
        const missingSlots = slots.filter(
          (slot) => slotCache[slot] === undefined,
        );
        if (missingSlots.length > 0) {
          const fetched = await Effect.runPromise(
            evm.readStorage({ address: app.address, slots: missingSlots }),
          );
          for (const [slot, value] of Object.entries(fetched) as [
            Hex.Hex,
            Hex.Hex,
          ][]) {
            slotCache[slot] = value;
          }

          while (Object.keys(slotCache).length > SLOT_CACHE_MAX_ENTRIES) {
            const oldestSlot = Object.keys(slotCache).values().next().value;
            delete slotCache[oldestSlot as Hex.Hex];
          }
        }

        return Object.fromEntries(
          slots.map((slot) => [slot, slotCache[slot]!]),
        ) as RawSlotMap;
      },
      knownPaths,
    );

    return { evm, state, knownPaths, invalidateStorageCache };
  });
}

function batchBlockToFifoBlock(
  block: RuntimeBlock<"batch">,
): RuntimeBlock<"fifo"> {
  const { batches, forceIncludedMutations, ...rest } = block;
  return {
    ...rest,
    mutations: [
      ...batches.flatMap((batch) => batch.mutations as SubmittedMutation[]),
      ...forceIncludedMutations,
    ],
  };
}

export function createRuntimeEffect(
  app: InternalApp & { sequencing: { order: "fifo" } },
): Effect.Effect<
  InternalRuntimeFFCA<"fifo">,
  unknown,
  Database | Rpc | Watch | Scope.Scope
>;
export function createRuntimeEffect(
  app: InternalApp & { sequencing: { order: "batch" } },
): Effect.Effect<
  InternalRuntimeFFCA<"batch">,
  unknown,
  Database | Rpc | Watch | Scope.Scope
>;
export function createRuntimeEffect(
  app: InternalApp,
): Effect.Effect<
  InternalRuntimeFFCA<"fifo" | "batch">,
  unknown,
  Database | Rpc | Watch | Scope.Scope
>;
export function createRuntimeEffect(
  app: InternalApp,
): Effect.Effect<
  InternalRuntimeFFCA<"fifo" | "batch">,
  unknown,
  Database | Rpc | Watch | Scope.Scope
> {
  return Effect.gen(function* () {
    const db = yield* Database;
    const rpc = yield* Rpc;
    const watch = yield* Watch;
    const scope = yield* Scope.Scope;

    const schema = app.schema;
    const { evm, state, knownPaths, invalidateStorageCache } =
      yield* createRuntimeState(app);
    const knownPathSet = new Set(knownPaths);

    let mutationId = yield* selectNextMutationId(schema);
    let batchId = 0;
    let batchPosition = 0;

    const mutationsById = new Map<number, RuntimeMutation>();
    const batchesById = new Map<number, RuntimeBatch>();
    const receivedMutationQueue = yield* Queue.unbounded<{
      mutationId: number;
      deferred: Deferred.Deferred<AcceptedMutation, unknown>;
    }>();
    const enqueuedMutationsQueue = yield* Queue.unbounded<number>();
    const acceptedBatchesQueue = yield* Queue.unbounded<number>();
    yield* Scope.addFinalizer(scope, Queue.shutdown(receivedMutationQueue));
    yield* Scope.addFinalizer(scope, Queue.shutdown(enqueuedMutationsQueue));
    yield* Scope.addFinalizer(scope, Queue.shutdown(acceptedBatchesQueue));

    const withSpeculativeStateLock = Semaphore.withPermits(
      Semaphore.makeUnsafe(1),
      1,
    );

    let nonce = Hex.toNumber(
      yield* rpc.request({
        method: "eth_getTransactionCount",
        params: [app.account.address, "latest"],
      }),
    );
    const nextNonce = Effect.sync(() => nonce++);

    const batchOrder =
      app.sequencing.order === "batch" ? app.sequencing.batchOrder : [];

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
        knownPaths: readonly string[];
      },
      unknown
    > {
      return Effect.gen(function* () {
        const {
          executeResult,
          knownPaths: mutationKnownPaths,
          mutation: acceptedMutation,
        } = yield* executeMutation({
          app,
          state,
          evm,
          mutation,
        }).pipe(
          Effect.tapError((error) => {
            const rejectedMutation = updateMutationToRejected(mutation, {
              error,
            });

            mutationsById.delete(mutation.id);

            emitMutation(mutationToEvent(rejectedMutation));

            return Effect.void;
          }),
        );

        invalidateStorageCache(
          executeResult.slot_writes.map((write) => write.slot),
        );

        mutationsById.set(acceptedMutation.id, acceptedMutation);
        for (const path of mutationKnownPaths) {
          if (knownPathSet.has(path)) continue;
          knownPathSet.add(path);
          knownPaths.push(path);
        }

        emitMutation(mutationToEvent(acceptedMutation));

        return {
          mutation: acceptedMutation,
          executeResult,
          knownPaths: mutationKnownPaths,
        };
      });
    }

    const acceptBatch = withSpeculativeStateLock(
      Effect.gen(function* () {
        const batchStartedAtMs = startTimer();
        const submittedMutations = yield* Queue.clear(receivedMutationQueue);

        if (submittedMutations.length === 0) {
          return;
        }

        if (batchOrder.length > 0) {
          submittedMutations.sort(
            (a, b) =>
              batchOrder.indexOf(
                (mutationsById.get(a.mutationId)! as ReceivedMutation).name,
              ) -
              batchOrder.indexOf(
                (mutationsById.get(b.mutationId)! as ReceivedMutation).name,
              ),
          );
        }

        const acceptedMutations: {
          mutation: AcceptedMutation;
          executeResult: ExecuteResult;
          knownPaths: readonly string[];
          deferred: Deferred.Deferred<AcceptedMutation, unknown>;
        }[] = [];

        for (const { mutationId, deferred } of submittedMutations) {
          const mutation = mutationsById.get(mutationId)! as ReceivedMutation;
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

        const persistStartedAtMs = startTimer();
        yield* db.transaction((tx) =>
          Effect.gen(function* () {
            yield* insertMutations(
              tx,
              schema,
              acceptedMutations.map((entry) => entry.mutation),
            );
            yield* insertSlotWritesMany(tx, schema, acceptedMutations);
            yield* insertKnownPaths(
              tx,
              schema,
              dedupe(acceptedMutations.flatMap(({ knownPaths }) => knownPaths)),
            );
          }),
        );

        yield* Effect.logDebug("persisted accepted mutations").pipe(
          Effect.annotateLogs({
            mutationCount: acceptedMutations.length,
            duration: durationMs(persistStartedAtMs),
          }),
        );

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

        yield* Queue.offer(acceptedBatchesQueue, batch.id);

        for (const { mutation, deferred } of acceptedMutations) {
          yield* Deferred.succeed(deferred, mutation);
        }
      }),
    );

    const submit = Effect.gen(function* () {
      const simulation = yield* withSpeculativeStateLock(
        Effect.gen(function* () {
          const batchIds = yield* Queue.clear(acceptedBatchesQueue);
          const enqueuedMutationIds = yield* Queue.clear(
            enqueuedMutationsQueue,
          );
          if (batchIds.length === 0 && enqueuedMutationIds.length === 0) {
            return undefined;
          }

          const batches = batchIds.map((id) => batchesById.get(id)!);

          const acceptedEnqueuedMutations: {
            mutation: Extract<AcceptedMutation, { isForceInclusion: true }>;
            executeResult: ExecuteResult;
            knownPaths: readonly string[];
          }[] = [];
          for (const mutationId of enqueuedMutationIds) {
            const enqueuedMutation = mutationsById.get(
              mutationId,
            )! as EnqueuedMutation;
            acceptedEnqueuedMutations.push(
              (yield* acceptMutation(enqueuedMutation)) as {
                mutation: Extract<AcceptedMutation, { isForceInclusion: true }>;
                executeResult: ExecuteResult;
                knownPaths: readonly string[];
              },
            );
          }

          if (acceptedEnqueuedMutations.length > 0) {
            yield* db.transaction((tx) =>
              Effect.gen(function* () {
                yield* insertMutations(
                  tx,
                  schema,
                  acceptedEnqueuedMutations.map((entry) => entry.mutation),
                );
                yield* insertSlotWritesMany(
                  tx,
                  schema,
                  acceptedEnqueuedMutations,
                );
                yield* insertKnownPaths(
                  tx,
                  schema,
                  dedupe(
                    acceptedEnqueuedMutations.flatMap(
                      (entry) => entry.knownPaths,
                    ),
                  ),
                );
              }),
            );
          }

          const acceptedForceIncludedMutations = acceptedEnqueuedMutations.map(
            ({ mutation }) => mutation,
          );

          const speculativeJournalIds = batches
            .flatMap((batch) => batch.mutations)
            .map((mutation) => mutation.journalId)
            .concat(
              acceptedForceIncludedMutations.map(
                (mutation) => mutation.journalId,
              ),
            );

          const calldata = encodeExecuteCalldata(
            batches.map((batch) =>
              encodeBatchArg(app.signature.params, batch.mutations),
            ),
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
            return yield* Effect.fail(
              createRevmRevertError(
                simulateResult.revert_data,
                "revm simulate reverted",
              ),
            );
          }

          yield* Effect.logDebug("simulated transaction submission").pipe(
            Effect.annotateLogs({
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

      const submitNonce = yield* nextNonce;
      const transactionStartedAtMs = startTimer();

      // Fees come from `eth_fillTransaction` (round-robined); gas, nonce, and
      // access list come from the local simulation. The node returns the
      // fully-filled transaction as `raw`, which we parse straight back into a
      // signable transaction (instead of rebuilding it field by field), sign
      // locally, and broadcast via the multiplexed `eth_sendRawTransactionSync`
      // so the fastest non-erroring provider wins.
      const filled = yield* rpc.request({
        method: "eth_fillTransaction",
        params: [
          {
            from: app.account.address,
            to: app.address,
            data: calldata,
            gas: Hex.fromNumber(simulateResult.gas_limit),
            nonce: Hex.fromNumber(submitNonce),
            accessList: simulateResult.access_list,
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
        catch: (error) => error as Error,
      });

      const receipt = formatTransactionReceipt(
        yield* rpc.requestMultiplexed({
          method: "eth_sendRawTransactionSync",
          params: [signed],
        }),
      );

      if (receipt.status === "reverted") {
        return yield* Effect.fail(
          createRevmRevertError(
            undefined,
            `settlement transaction reverted onchain: ${receipt.transactionHash}`,
          ),
        );
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

      for (const batch of batches) {
        batch.status = "included";
        for (const mutation of batch.mutations) {
          updateMutationToIncluded(mutation as AcceptedMutation);
        }
      }

      const forceIncludedMutations = acceptedForceIncludedMutations.map(
        updateMutationToIncluded,
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

      const includedMutations: SubmittedMutation[] = [
        ...batches.flatMap((batch) => batch.mutations as SubmittedMutation[]),
        ...forceIncludedMutations,
      ];
      yield* db.transaction((tx) =>
        updateMutationsLifecycle(tx, schema, includedMutations, runtimeBlock),
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
              const enqueuedMutation: EnqueuedMutation = decodeEnqueuedMutation(
                {
                  app,
                  log,
                  id: mutationId++,
                },
              );

              const executeResult = yield* withSpeculativeStateLock(
                enqueueMutation({ app, evm, mutation: enqueuedMutation }),
              );

              if (executeResult.success === false) {
                continue;
              }

              invalidateStorageCache(
                executeResult.slot_writes.map((write) => write.slot),
              );

              mutationsById.set(enqueuedMutation.id, enqueuedMutation);
              yield* Queue.offer(enqueuedMutationsQueue, enqueuedMutation.id);
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
                  if (nextStatus === "safe") {
                    updateMutationToSafe(mutation as SubmittedMutation);
                  } else {
                    updateMutationToFinalized(mutation as SubmittedMutation);
                  }
                }
              }
              for (const mutation of block.forceIncludedMutations) {
                if (nextStatus === "safe") {
                  updateMutationToSafe(mutation);
                } else {
                  updateMutationToFinalized(mutation);
                }
              }

              const submittedMutations = [
                ...block.batches.flatMap(
                  (batch) => batch.mutations as SubmittedMutation[],
                ),
                ...block.forceIncludedMutations,
              ];

              if (nextStatus === "finalized") {
                yield* evm.pruneJournals({
                  journal_ids: submittedMutations.map(
                    (mutation) => mutation.journalId,
                  ),
                });
                for (const batch of block.batches) {
                  batchesById.delete(batch.id);
                  for (const mutation of batch.mutations) {
                    mutationsById.delete(mutation.id);
                  }
                }
                for (const mutation of block.forceIncludedMutations) {
                  mutationsById.delete(mutation.id);
                }
              }

              yield* db.transaction((tx) =>
                updateMutationsLifecycle(tx, schema, submittedMutations, block),
              );

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

    const batchIntervalMs =
      app.sequencing.order === "batch"
        ? app.sequencing.batchIntervalMs
        : FIFO_BATCH_INTERVAL_MS;
    const submitIntervalMs = app.sequencing.submitIntervalMs;

    const batchProgram = Effect.sleep(Duration.millis(batchIntervalMs)).pipe(
      Effect.andThen(
        Effect.repeat(
          acceptBatch,
          Schedule.fixed(Duration.millis(batchIntervalMs)),
        ),
      ),
    );
    const submitProgram = Effect.sleep(Duration.millis(submitIntervalMs)).pipe(
      Effect.andThen(
        Effect.repeat(
          submit,
          Schedule.fixed(Duration.millis(submitIntervalMs)),
        ),
      ),
    );

    const program = Effect.all([batchProgram, submitProgram, watchProgram], {
      concurrency: "unbounded",
    });

    function execute(
      mutation: FFCAMutation,
    ): Effect.Effect<FFCAMutationResult, unknown> {
      return Effect.gen(function* () {
        const mutationConfig = app.mutations[mutation.name]!;

        const runtimeMutation = {
          ...mutation,
          id: mutationId++,
          status: "received",
          config: mutationConfig,
        } as const satisfies ReceivedMutation;

        yield* Effect.logDebug("received mutation").pipe(
          Effect.annotateLogs({
            id: runtimeMutation.id,
            name: runtimeMutation.name,
            args: runtimeMutation.args,
          }),
        );

        mutationsById.set(runtimeMutation.id, runtimeMutation);

        emitMutation(mutationToEvent(runtimeMutation));

        const deferred = yield* Deferred.make<AcceptedMutation, unknown>();

        yield* Queue.offer(receivedMutationQueue, {
          mutationId: runtimeMutation.id,
          deferred,
        });

        const acceptedMutation = yield* Deferred.await(deferred).pipe(
          Effect.tapError((error) =>
            Effect.logError(error).pipe(
              Effect.annotateLogs({
                message: "rejected mutation",
                id: runtimeMutation.id,
                name: runtimeMutation.name,
                args: runtimeMutation.args,
              }),
            ),
          ),
        );

        yield* Effect.logDebug("accepted mutation").pipe(
          Effect.annotateLogs({
            id: runtimeMutation.id,
            name: runtimeMutation.name,
            args: runtimeMutation.args,
          }),
        );

        return {
          id: acceptedMutation.id,
          resolution: acceptedMutation.resolution,
        };
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
      state,
      schema,
      execute,
      program,
      on,
    } as InternalRuntimeFFCA<"fifo" | "batch">;
  });
}

export function nextBlockStatus(
  block: Pick<RuntimeBlock<"fifo" | "batch">, "number" | "status">,
  currentBlockNumber: bigint,
  confirmations: InternalApp["confirmations"],
): "safe" | "finalized" | undefined {
  const blockDepth = currentBlockNumber - block.number;
  if (
    blockDepth >= BigInt(confirmations.finalizedBlockDepth) &&
    block.status !== "finalized"
  ) {
    return "finalized";
  }

  if (
    blockDepth >= BigInt(confirmations.safeBlockDepth) &&
    block.status !== "safe" &&
    block.status !== "finalized"
  ) {
    return "safe";
  }

  return undefined;
}
