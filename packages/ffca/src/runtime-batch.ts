import {
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
import { Hex } from "ox";
import { sendRawTransactionSync } from "viem/actions";
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
  InternalRuntimeFFCA,
  MutationListener,
} from "./ffca";
import type { InternalApp } from "./internal";
import { durationMs, loggerLayer, startTimer } from "./logger";
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

export function createRuntimeBatchEffect(
  app: InternalApp,
): Effect.Effect<
  InternalRuntimeFFCA<"batch">,
  unknown,
  Database | Rpc | Watch | Scope.Scope
> {
  return Effect.gen(function* () {
    const db = yield* Database;
    const rpc = yield* Rpc;
    const watch = yield* Watch;
    const scope = yield* Scope.Scope;

    const schema = app.schema;
    const { evm, state, knownPaths } = yield* createRuntimeState(app);

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
    const acceptedForceInclusionMutationsQueue =
      yield* Queue.unbounded<number>();
    yield* Scope.addFinalizer(scope, Queue.shutdown(receivedMutationQueue));
    yield* Scope.addFinalizer(scope, Queue.shutdown(enqueuedMutationsQueue));
    yield* Scope.addFinalizer(scope, Queue.shutdown(acceptedBatchesQueue));
    yield* Scope.addFinalizer(
      scope,
      Queue.shutdown(acceptedForceInclusionMutationsQueue),
    );

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

    const walletClient = createRuntimeWalletClient(app);

    const batchOrder =
      app.sequencing.order === "batch" ? app.sequencing.batchOrder : [];

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

        mutationsById.set(acceptedMutation.id, acceptedMutation);
        knownPaths.push(...mutationKnownPaths);

        const persistStartedAtMs = startTimer();
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

        yield* Effect.logDebug("persisted accepted mutation").pipe(
          Effect.annotateLogs({
            id: acceptedMutation.id,
            name: acceptedMutation.name,
            duration: durationMs(persistStartedAtMs),
          }),
        );

        emitMutation(mutationToEvent(acceptedMutation));

        return acceptedMutation;
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
          const forceIncludedIds = yield* Queue.clear(
            acceptedForceInclusionMutationsQueue,
          );
          if (batchIds.length === 0 && forceIncludedIds.length === 0) {
            return undefined;
          }

          const acceptedForceIncludedMutations = forceIncludedIds.map(
            (id) =>
              mutationsById.get(id)! as Extract<
                AcceptedMutation,
                { isForceInclusion: true }
              >,
          );

          const batches = batchIds.map((id) => batchesById.get(id)!);

          // Sort journal ids ascending so they're passed to simulate in
          // application order: revm rewinds in reverse and replays forward,
          // and each journal's pre-image is only valid relative to the DB
          // state that existed when execute ran. Force-included mutations
          // accepted by watchProgram before the next acceptBatch can have
          // smaller ids than the batched mutations, so plain concatenation
          // would mis-order rewinds when journals overlap on the same slot.
          // Journal ids are monotonic in the order evm.execute runs
          // (ffca-evm/src/main.rs:299-301), so ascending = application order.
          const speculativeJournalIds = batches
            .flatMap((batch) => batch.mutations)
            .map((mutation) => mutation.journalId)
            .concat(
              acceptedForceIncludedMutations.map(
                (mutation) => mutation.journalId,
              ),
            )
            .sort((a, b) => a - b);

          const calldata = encodeExecuteCalldata(
            app.abi,
            batches.map((batch) => encodeBatchArg(app.abi, batch.mutations)),
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
                app,
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

          const enqueuedMutationIds = yield* Queue.clear(
            enqueuedMutationsQueue,
          );
          for (const mutationId of enqueuedMutationIds) {
            const enqueuedMutation = mutationsById.get(
              mutationId,
            )! as EnqueuedMutation;
            const acceptedMutation = yield* acceptMutation(enqueuedMutation);

            yield* Queue.offer(
              acceptedForceInclusionMutationsQueue,
              acceptedMutation.id,
            );
          }

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
      const request = yield* Effect.tryPromise({
        try: () =>
          walletClient.prepareTransactionRequest({
            to: app.address,
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
          for (const mutation of forceIncludedMutations) {
            yield* updateMutationLifecycle(tx, schema, mutation, runtimeBlock);
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

              mutationsById.set(enqueuedMutation.id, enqueuedMutation);

              const acceptedBatchCount =
                yield* Queue.size(acceptedBatchesQueue);

              if (acceptedBatchCount > 0) {
                yield* Queue.offer(enqueuedMutationsQueue, enqueuedMutation.id);
              } else {
                const acceptedMutation = yield* withSpeculativeStateLock(
                  acceptMutation(enqueuedMutation),
                );

                yield* Queue.offer(
                  acceptedForceInclusionMutationsQueue,
                  acceptedMutation.id,
                );
              }
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
      app.sequencing.order === "batch" ? app.sequencing.batchIntervalMs : 0;
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
      schema,
      execute,
      program,
      on,
    };
  });
}
