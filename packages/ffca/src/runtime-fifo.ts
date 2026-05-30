import {
  Duration,
  Effect,
  Queue,
  Schedule,
  Scope,
  Semaphore,
  Stream,
} from "effect";
import { Hex } from "ox";
import { formatTransactionReceipt, parseTransaction } from "viem";
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
  BlockListener,
  InternalRuntimeFFCA,
  MutationListener,
} from "./ffca";
import type { InternalApp } from "./internal";
import { durationMs, loggerLayer, startTimer } from "./logger";
import { Rpc } from "./rpc";
import { requestBlock } from "./rpc-request";
import {
  createRevmRevertError,
  createRuntimeState,
  decodeEnqueuedMutation,
  enqueueMutation,
  executeMutation,
  fifoBlockToEvent,
  mutationToEvent,
  nextBlockStatus,
  updateMutationToFinalized,
  updateMutationToIncluded,
  updateMutationToRejected,
  updateMutationToSafe,
} from "./runtime";
import type {
  AcceptedMutation,
  BlockEvent,
  EnqueuedMutation,
  FFCAMutation,
  FFCAMutationResult,
  MutationEvent,
  ReceivedMutation,
  RuntimeBlock,
  RuntimeMutation,
} from "./types";
import { Watch } from "./watch";

export function createRuntimeFIFOEffect(
  app: InternalApp,
): Effect.Effect<
  InternalRuntimeFFCA<"fifo">,
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

    const mutationsById = new Map<number, RuntimeMutation>();
    const enqueuedMutationsQueue = yield* Queue.unbounded<number>();
    const acceptedMutationsQueue = yield* Queue.unbounded<number>();
    yield* Scope.addFinalizer(scope, Queue.shutdown(acceptedMutationsQueue));
    yield* Scope.addFinalizer(scope, Queue.shutdown(enqueuedMutationsQueue));
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

    let unfinalizedBlocks: RuntimeBlock<"fifo">[] = [];
    const mutationListeners = new Set<MutationListener>();
    const blockListeners = new Set<BlockListener<"fifo">>();

    const emitMutation = (event: MutationEvent) => {
      for (const cb of mutationListeners) {
        try {
          cb(event);
        } catch {}
      }
    };

    const emitBlock = (event: BlockEvent<"fifo">) => {
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

        invalidateStorageCache(
          executeResult.slot_writes.map((write) => write.slot),
        );

        mutationsById.set(acceptedMutation.id, acceptedMutation);
        for (const path of mutationKnownPaths) {
          if (knownPathSet.has(path)) continue;
          knownPathSet.add(path);
          knownPaths.push(path);
        }

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

        yield* Queue.offer(acceptedMutationsQueue, acceptedMutation.id);

        return acceptedMutation;
      });
    }

    const submit = Effect.gen(function* () {
      const simulation = yield* withSpeculativeStateLock(
        Effect.gen(function* () {
          const mutationIds = yield* Queue.clear(acceptedMutationsQueue);
          if (mutationIds.length === 0) return undefined;

          const forceInclusions = mutationIds
            .map((id) => mutationsById.get(id)! as AcceptedMutation)
            .filter((mutation) => mutation.isForceInclusion);

          const mutations = mutationIds
            .map((id) => mutationsById.get(id)! as AcceptedMutation)
            .filter((mutation) => mutation.isForceInclusion === false);

          const speculativeJournalIds = mutationIds
            .map((id) => mutationsById.get(id)! as AcceptedMutation)
            .map((mutation) => mutation.journalId);

          const calldata = encodeExecuteCalldata(
            [encodeBatchArg(app.signature.params, mutations)],
            forceInclusions.map(({ queueIndex }) => queueIndex),
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

            yield* acceptMutation(enqueuedMutation);
          }

          return {
            mutations,
            forceInclusions,
            calldata,
            simulateResult,
          };
        }),
      );

      if (simulation === undefined) return;

      const { mutations, forceInclusions, calldata, simulateResult } =
        simulation;

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

      const includedMutations = mutations
        .map(updateMutationToIncluded)
        .concat(forceInclusions.map(updateMutationToIncluded));

      const runtimeBlock: RuntimeBlock<"fifo"> = {
        status: "included",
        number: block.number,
        hash: block.hash,
        timestamp: block.timestamp,
        transactionHash: receipt.transactionHash,
        mutations: includedMutations,
        // enqueues: [],
        // forceExecutes: [],
      };

      yield* db.transaction((tx) =>
        Effect.gen(function* () {
          for (const mutation of includedMutations) {
            yield* updateMutationLifecycle(tx, schema, mutation, runtimeBlock);
          }
        }),
      );

      emitBlock(fifoBlockToEvent(runtimeBlock));
      for (const mutation of includedMutations) {
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

              const executeResult = yield* enqueueMutation({
                app,
                evm,
                mutation: enqueuedMutation,
              });

              if (executeResult.success === false) {
                continue;
              }

              invalidateStorageCache(
                executeResult.slot_writes.map((write) => write.slot),
              );

              mutationsById.set(enqueuedMutation.id, enqueuedMutation);

              const acceptedMutationCount = yield* Queue.size(
                acceptedMutationsQueue,
              );

              if (acceptedMutationCount > 0) {
                yield* Queue.offer(enqueuedMutationsQueue, enqueuedMutation.id);
              } else {
                yield* withSpeculativeStateLock(
                  acceptMutation(enqueuedMutation),
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

              for (const mutation of block.mutations) {
                if (nextStatus === "safe") {
                  updateMutationToSafe(mutation);
                } else {
                  updateMutationToFinalized(mutation);
                }
              }

              if (nextStatus === "finalized") {
                yield* evm.pruneJournals({
                  journal_ids: block.mutations.map(
                    (mutation) => mutation.journalId,
                  ),
                });
                for (const mutation of block.mutations) {
                  mutationsById.delete(mutation.id);
                }
              }

              yield* db.transaction((tx) =>
                Effect.gen(function* () {
                  for (const mutation of block.mutations) {
                    yield* updateMutationLifecycle(tx, schema, mutation, block);
                  }
                }),
              );

              emitBlock(fifoBlockToEvent(block));

              for (const mutation of block.mutations) {
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
    const submitProgram = Effect.sleep(Duration.millis(submitIntervalMs)).pipe(
      Effect.andThen(
        Effect.repeat(
          submit,
          Schedule.fixed(Duration.millis(submitIntervalMs)),
        ),
      ),
    );

    const program = Effect.all([submitProgram, watchProgram], {
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
        } as const satisfies Extract<RuntimeMutation, { status: "received" }>;

        yield* Effect.logDebug("received mutation").pipe(
          Effect.annotateLogs({
            id: runtimeMutation.id,
            name: runtimeMutation.name,
            args: runtimeMutation.args,
          }),
        );

        mutationsById.set(runtimeMutation.id, runtimeMutation);

        emitMutation(mutationToEvent(runtimeMutation));

        const acceptedMutation = yield* withSpeculativeStateLock(
          acceptMutation(runtimeMutation),
        ).pipe(
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
    function on(
      event: "block",
      cb: BlockListener<"fifo">,
    ): Effect.Effect<() => void>;
    function on(
      event: "mutation" | "block",
      cb: MutationListener | BlockListener<"fifo">,
    ): Effect.Effect<() => void> {
      return Effect.sync(() => {
        if (event === "mutation") {
          const listener = cb as MutationListener;
          mutationListeners.add(listener);
          return () => mutationListeners.delete(listener);
        }

        const listener = cb as BlockListener<"fifo">;
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
