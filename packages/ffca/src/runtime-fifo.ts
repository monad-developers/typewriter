import type { PgTable } from "drizzle-orm/pg-core";
import {
  Duration,
  Effect,
  Logger,
  Queue,
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
import type { BlockListener, MutationListener, RuntimeFFCA } from "./ffca";
import { Rpc, rpcRetry } from "./rpc";
import { requestBlock } from "./rpc-request";
import {
  createRevmRevertError,
  createRuntimeState,
  createRuntimeWalletClient,
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
import type { FFCASchema } from "./schema";
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

export function createRuntimeFIFOEffect<const config extends FFCAConfig>(
  config: config,
  schema: Record<string, PgTable>,
): Effect.Effect<
  RuntimeFFCA<config, "fifo">,
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

    const mutationsById = new Map<number, RuntimeMutation>();
    const enqueuedMutationsQueue = yield* Queue.unbounded<number>();
    const acceptedMutationsQueue = yield* Queue.unbounded<number>();
    yield* Scope.addFinalizer(scope, Queue.shutdown(acceptedMutationsQueue));
    yield* Scope.addFinalizer(scope, Queue.shutdown(enqueuedMutationsQueue));
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
            config.abi,
            [encodeBatchArg(config.abi, mutations)],
            forceInclusions.map(({ queueIndex }) => queueIndex),
          );

          const simulateResult = yield* evm.simulate({
            from: config.account.address,
            to: config.address,
            data: calldata,
            journal_ids: speculativeJournalIds,
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

          const enqueuedMutationIds = yield* Queue.clear(
            enqueuedMutationsQueue,
          );
          for (const mutationId of enqueuedMutationIds) {
            const enqueuedMutation = mutationsById.get(
              mutationId,
            )! as EnqueuedMutation;

            yield* acceptMutation(enqueuedMutation);
          }

          return { mutations, forceInclusions, calldata, simulateResult };
        }),
      );

      if (simulation === undefined) return;

      const { mutations, forceInclusions, calldata, simulateResult } =
        simulation;

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

      const includedMutations = mutations
        .map(updateMutationToIncluded)
        .concat(forceInclusions.map(updateMutationToIncluded));

      const block = yield* requestBlock(receipt.blockHash).pipe(
        Effect.provideService(Rpc, rpc),
      );

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

      for (const mutation of includedMutations) {
        yield* db.transaction((tx) =>
          updateMutationLifecycle(tx, schema, mutation, runtimeBlock),
        );
      }

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
              //   for (const block of unfinalizedBlocks) {
              //     for (const batch of block.batches) {
              //       const isReorged = message.reorgedBlocks.some((r) =>
              //         r.transactions.includes(block.transactionHash),
              //       );
              //       if (isReorged) {
              //         const reIncludedBlock = message.newBlocks.find((r) =>
              //           r.transactions.includes(block.transactionHash),
              //         );
              //         if (reIncludedBlock === undefined) {
              //           return yield* Effect.fail(
              //             new Error(
              //               `reorged batch removed from canonical chain: batchId=${batch.id} transactionHash=${block.transactionHash}`,
              //             ),
              //           );
              //         }
              //       }
              //     }
              //   }
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

              const executeResult = yield* enqueueMutation({
                config,
                evm,
                mutation: enqueuedMutation,
              });

              if (executeResult.success === false) {
                continue;
              }

              mutationsById.set(enqueuedMutation.id, enqueuedMutation);

              // const enqueue: RuntimeEnqueue = {
              //   transactionHash: log.transactionHash,
              //   journalId: executeResult.journal_id!,
              //   mutation: enqueuedMutation,
              // };

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
                config.confirmations,
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

    const submitProgram = Effect.sleep(Duration.millis(400)).pipe(
      Effect.andThen(
        Effect.repeat(submit, Schedule.fixed(Duration.millis(400))),
      ),
    );

    const program = Effect.all([submitProgram, watchProgram], {
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
        } as const satisfies Extract<RuntimeMutation, { status: "received" }>;

        mutationsById.set(runtimeMutation.id, runtimeMutation);

        emitMutation(mutationToEvent(runtimeMutation));

        const acceptedMutation = yield* withSpeculativeStateLock(
          acceptMutation(runtimeMutation),
        );

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
      schema: schema as FFCASchema<config>,
      execute,
      program,
      on,
    };
  });
}
