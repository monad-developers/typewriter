import type { PgTable } from "drizzle-orm/pg-core";
import {
  Deferred,
  Duration,
  Effect,
  Logger,
  Queue,
  Result,
  Schedule,
  Scope,
  Semaphore,
  Stream,
} from "effect";
import { Hex } from "ox";
import { sendRawTransactionSync } from "viem/actions";
import type { FFCAConfig } from "./config";
import { Database } from "./db";
import {
  insertKnownPaths,
  insertMutation,
  insertSlotWrites,
  selectNextMutationId,
  updateMutationLifecycle,
} from "./db-query";
import { encodeBatchArg, encodeExecuteCalldata } from "./encoding";
import type {
  BatchListener,
  BlockListener,
  MutationListener,
  RuntimeFFCA,
} from "./ffca";
import { Rpc, rpcRetry } from "./rpc";
import { requestBlock } from "./rpc-request";
import {
  batchBlockToEvent,
  batchToEvent,
  createRevmRevertError,
  createRuntimeState,
  createRuntimeWalletClient,
  decodeEnqueuedMutation,
  enqueueMutation,
  executeMutation,
  mutationToEvent,
  nextBlockStatus,
  updateMutationToFinalized,
  updateMutationToIncluded,
  updateMutationToRejected,
  updateMutationToSafe,
} from "./runtime";
import type { FFCASchema } from "./schema";
import type {
  AcceptedMutation,
  BatchEvent,
  BlockEvent,
  EnqueuedMutation,
  FFCAMutation,
  FFCAMutationResult,
  MutationEvent,
  ReceivedMutation,
  RuntimeBatch,
  RuntimeBlock,
  RuntimeMutation,
  SubmittedMutation,
} from "./types";
import { Watch } from "./watch";

const DEFAULT_BATCH_INTERVAL_MS = 50;
const DEFAULT_SUBMIT_INTERVAL_MS = 400;

export function createRuntimeBatchEffect<const config extends FFCAConfig>(
  config: config,
  schema: Record<string, PgTable>,
): Effect.Effect<
  RuntimeFFCA<config, "batch">,
  unknown,
  Database | Rpc | Watch | Scope.Scope
> {
  return Effect.gen(function* () {
    const db = yield* Database;
    const rpc = yield* Rpc;
    const watch = yield* Watch;
    const scope = yield* Scope.Scope;

    const { evm, state, knownPaths } = yield* createRuntimeState(
      config,
      schema,
    );

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

    let nonce: number | undefined;
    const nextNonce = Effect.gen(function* () {
      if (nonce === undefined) {
        nonce = Hex.toNumber(
          yield* rpc.request({
            method: "eth_getTransactionCount",
            params: [config.account.address, "latest"],
          }),
        );
      }
      return nonce++;
    });

    const walletClient = createRuntimeWalletClient(config);

    const batchOrder =
      config.sequencing !== undefined && "batchOrder" in config.sequencing
        ? config.sequencing.batchOrder
        : undefined;

    let unfinalizedBlocks: RuntimeBlock<"batch">[] = [];
    const mutationListeners = new Set<MutationListener>();
    const batchListeners = new Set<BatchListener>();
    const blockListeners = new Set<BlockListener<"batch">>();

    const emitMutation = (event: MutationEvent) => {
      for (const cb of mutationListeners) {
        try {
          cb(event);
        } catch {}
      }
    };

    const emitBatch = (event: BatchEvent) => {
      for (const cb of batchListeners) {
        try {
          cb(event);
        } catch {}
      }
    };

    const emitBlock = (event: BlockEvent<"batch">) => {
      for (const cb of blockListeners) {
        try {
          cb(event);
        } catch {}
      }
    };

    function acceptMutation(mutation: ReceivedMutation | EnqueuedMutation) {
      return Effect.gen(function* () {
        const {
          executeResult,
          knownPaths: mutationKnownPaths,
          mutation: acceptedMutation,
        } = yield* executeMutation({
          config,
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

        mutationsById.set(acceptedMutation.id, acceptedMutation);
        knownPaths.push(...mutationKnownPaths);

        yield* db.transaction((tx) =>
          Effect.gen(function* () {
            yield* insertMutation(tx, schema, acceptedMutation);
            yield* insertSlotWrites(
              tx,
              schema,
              acceptedMutation,
              executeResult.slot_writes,
            );
            yield* insertKnownPaths(tx, schema, mutationKnownPaths);
          }),
        );

        emitMutation(mutationToEvent(acceptedMutation));

        return acceptedMutation;
      });
    }

    const acceptBatch = withSpeculativeStateLock(
      Effect.gen(function* () {
        const submittedMutations = yield* Queue.clear(receivedMutationQueue);

        if (submittedMutations.length === 0) {
          return;
        }

        if (batchOrder !== undefined) {
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
          deferred: Deferred.Deferred<AcceptedMutation, unknown>;
        }[] = [];

        for (const { mutationId, deferred } of submittedMutations) {
          const mutation = mutationsById.get(mutationId)! as ReceivedMutation;
          const result = yield* Effect.result(acceptMutation(mutation));
          if (Result.isSuccess(result)) {
            acceptedMutations.push({ mutation: result.success, deferred });
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

        batchesById.set(batch.id, batch);

        emitBatch(batchToEvent(batch));

        yield* Queue.offer(acceptedBatchesQueue, batch.id);

        for (const { mutation, deferred } of acceptedMutations) {
          yield* Deferred.succeed(deferred, mutation);
        }
      }),
    );

    const submit = withSpeculativeStateLock(
      Effect.gen(function* () {
        const batchIds = yield* Queue.clear(acceptedBatchesQueue);
        if (batchIds.length === 0) return;

        const batches = batchIds.map((id) => batchesById.get(id)!);

        const calldata = encodeExecuteCalldata(
          config.abi,
          batches.map((batch) => encodeBatchArg(config.abi, batch.mutations)),
          [],
        );

        const simulateResult = yield* evm.simulate({
          from: config.account.address,
          to: config.address,
          data: calldata,
          journal_ids: batches
            .flatMap((batch) => batch.mutations)
            .map((mutation) => mutation.journalId),
        });
        if (simulateResult.success === false) {
          return yield* Effect.fail(
            createRevmRevertError(
              config,
              simulateResult.revert_data,
              "revm simulate reverted",
            ),
          );
        }

        const submitNonce = yield* nextNonce;
        const request = yield* Effect.tryPromise({
          try: () =>
            walletClient.prepareTransactionRequest({
              to: config.address,
              data: calldata,
              accessList: simulateResult.access_list,
              gas: BigInt(simulateResult.gas_limit),
              nonce: submitNonce,
            }),
          catch: (error) => error as Error,
        }).pipe(rpcRetry);

        const signed = yield* Effect.tryPromise({
          try: () => walletClient.signTransaction(request),
          catch: (error) => error as Error,
        });

        const receipt = yield* Effect.tryPromise({
          try: () =>
            sendRawTransactionSync(walletClient, {
              serializedTransaction: signed,
              throwOnReceiptRevert: true,
            }),
          catch: (error) => error as Error,
        });

        const block = yield* requestBlock(receipt.blockHash).pipe(
          Effect.provideService(Rpc, rpc),
        );

        for (const batch of batches) {
          batch.status = "included";
          for (const mutation of batch.mutations) {
            updateMutationToIncluded(mutation as AcceptedMutation);
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

        yield* db.transaction((tx) =>
          Effect.gen(function* () {
            for (const batch of batches) {
              for (const mutation of batch.mutations) {
                yield* updateMutationLifecycle(
                  tx,
                  schema,
                  mutation as SubmittedMutation,
                  runtimeBlock,
                );
              }
            }
          }),
        );

        emitBlock(batchBlockToEvent(runtimeBlock));
        for (const batch of batches) {
          emitBatch(batchToEvent(batch));
          for (const mutation of batch.mutations) {
            emitMutation(mutationToEvent(mutation));
          }
        }

        unfinalizedBlocks.push(runtimeBlock);
      }),
    );

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
                  config,
                  log,
                  id: mutationId++,
                },
              );

              const executeResult = yield* withSpeculativeStateLock(
                enqueueMutation({ config, evm, mutation: enqueuedMutation }),
              );

              if (executeResult.success === false) {
                continue;
              }

              mutationsById.set(enqueuedMutation.id, enqueuedMutation);

              yield* Queue.offer(enqueuedMutationsQueue, enqueuedMutation.id);
            }

            for (const block of unfinalizedBlocks.filter(
              (block) => block.number < message.block.number,
            )) {
              const nextStatus = nextBlockStatus(
                block,
                message.block.number,
                config.confirmations,
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

              if (nextStatus === "finalized") {
                yield* evm.pruneJournals({
                  journal_ids: block.batches
                    .flatMap((batch) => batch.mutations)
                    .map((mutation) => mutation.journalId),
                });
                for (const batch of block.batches) {
                  batchesById.delete(batch.id);
                  for (const mutation of batch.mutations) {
                    mutationsById.delete(mutation.id);
                  }
                }
              }

              yield* db.transaction((tx) =>
                Effect.gen(function* () {
                  for (const batch of block.batches) {
                    for (const mutation of batch.mutations) {
                      yield* updateMutationLifecycle(
                        tx,
                        schema,
                        mutation as SubmittedMutation,
                        block,
                      );
                    }
                  }
                }),
              );

              emitBlock(batchBlockToEvent(block));

              for (const batch of block.batches) {
                emitBatch(batchToEvent(batch));
                for (const mutation of batch.mutations) {
                  emitMutation(mutationToEvent(mutation));
                }
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
      config.sequencing !== undefined && "batchIntervalMs" in config.sequencing
        ? (config.sequencing.batchIntervalMs ?? DEFAULT_BATCH_INTERVAL_MS)
        : DEFAULT_BATCH_INTERVAL_MS;
    const submitIntervalMs =
      config.sequencing?.submitIntervalMs ?? DEFAULT_SUBMIT_INTERVAL_MS;

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
        const mutationConfig = config.mutations[mutation.name]!;

        const runtimeMutation = {
          ...mutation,
          id: mutationId++,
          status: "received",
          config: mutationConfig,
        } as const satisfies ReceivedMutation;

        mutationsById.set(runtimeMutation.id, runtimeMutation);

        emitMutation(mutationToEvent(runtimeMutation));

        const deferred = yield* Deferred.make<AcceptedMutation, unknown>();

        yield* Queue.offer(receivedMutationQueue, {
          mutationId: runtimeMutation.id,
          deferred,
        });

        const acceptedMutation = yield* Deferred.await(deferred);

        return {
          id: acceptedMutation.id,
          resolution: acceptedMutation.resolution,
        };
      }).pipe(Effect.provide(Logger.layer([Logger.formatJson])));
    }

    function on(
      event: "mutation",
      cb: MutationListener,
    ): Effect.Effect<() => void>;
    function on(event: "batch", cb: BatchListener): Effect.Effect<() => void>;
    function on(
      event: "block",
      cb: BlockListener<"batch">,
    ): Effect.Effect<() => void>;
    function on(
      event: "mutation" | "batch" | "block",
      cb: MutationListener | BatchListener | BlockListener<"batch">,
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

        const listener = cb as BlockListener<"batch">;
        blockListeners.add(listener);
        return () => blockListeners.delete(listener);
      });
    }

    return {
      state,
      schema: schema as FFCASchema<config>,
      execute,
      program,
      on,
    };
  });
}
