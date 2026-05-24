import type { PgTable } from "drizzle-orm/pg-core";
import {
  Cause,
  Deferred,
  Duration,
  Effect,
  Exit,
  Logger,
  Queue,
  Result,
  Schedule,
  Scope,
  Semaphore,
  Stream,
} from "effect";
import { createEVM, type ExecuteResult } from "ffca-evm";
import type { Hex, TypedData } from "ox";
import { createStorageProxy } from "storage-layout";
import {
  ContractFunctionRevertedError,
  createPublicClient,
  createWalletClient,
  decodeEventLog,
  extractChain,
  http,
  keccak256,
  RawContractError,
} from "viem";
import { sendRawTransactionSync } from "viem/actions";
import * as chains from "viem/chains";
import type { FFCAConfig, FFCAMutationConfig } from "./config";
import { Database } from "./db";
import {
  insertKnownPaths,
  insertMutation,
  insertSlotWrites,
  selectAccountStorage,
  selectKnownPaths,
  selectNextBundleId,
  selectNextMutationId,
  updateMutationLifecycle,
} from "./db-query";
import {
  decodeMutationCalldata,
  encodeBundleArg,
  encodeEnqueueCalldata,
  encodeExecuteCalldata,
  type FFCAAbi,
} from "./encoding";
import type {
  BlockListener,
  BundleListener,
  MutationListener,
  RuntimeFFCA,
} from "./ffca";
import { Rpc } from "./rpc";
import type { FFCASchema } from "./schema";
import type {
  BlockEvent,
  BundleEvent,
  MutationEvent,
  RuntimeBlock,
  RuntimeBundle,
  RuntimeMutation,
  SubmittedMutation,
} from "./types";
import { Watch } from "./watch";

// TODO sequencing: bundleOrder works. Next is a state-aware
//   callback (state, mutations) => ordered for fee-priority / fairness rules.
// TODO decoded projection: apps currently own read-model projection through
//   events/persistence hooks. Longer term, replace hand-authored projection
//   with storage diff decoding.
// TODO signature validation: decide whether execute() should verify signatures
//   before queue admission or leave validation to app-owned resolve/apply logic.
// TODO runtime failure policy: submit/watch failures still die the fiber; define
//   bundle status updates and retry/dead-letter behavior.
// TODO HTTP / SSE shaping: event fan-out exists in-process; network surfaces are
//   still app-owned.

const DEFAULT_BUNDLE_INTERVAL_MS = 50;
const DEFAULT_SUBMIT_INTERVAL_MS = 400;

type SubmittedMutationWithDeferred = {
  mutation: Extract<RuntimeMutation, { status: "submitted" }>;
  deferred: Deferred.Deferred<RuntimeMutation, unknown>;
};

type EnqueuedMutation = Extract<RuntimeMutation, { status: "enqueued" }>;

function mutationToEvent(mutation: RuntimeMutation): MutationEvent {
  const { config: _config, ...event } = mutation;
  return { ...event };
}

function bundleToEvent(bundle: RuntimeBundle): BundleEvent {
  return {
    ...bundle,
    mutations: bundle.mutations.map(
      mutationToEvent,
    ) as BundleEvent["mutations"],
  };
}

function blockToEvent(block: RuntimeBlock): BlockEvent {
  const {
    enqueues: _enqueues,
    forceExecutes: _forceExecutes,
    bundles,
    ...rest
  } = block;
  return {
    ...rest,
    bundles: bundles.map(bundleToEvent) as BlockEvent["bundles"],
  };
}

async function resolveMutation(
  mutation: Extract<RuntimeMutation, { status: "submitted" }>,
  state: unknown,
): Promise<unknown> {
  if ("resolve" in mutation.config) {
    // TODO(kyle) run `resolution` through zod to check shape
    return mutation.config.resolve({
      state,
      args: mutation.args,
      signature: mutation.signature,
    });
  }
  return undefined;
}

async function registerKnownPaths(
  mutation: Extract<
    RuntimeMutation,
    { status: "accepted" | "included" | "safe" | "finalized" }
  >,
): Promise<readonly string[]> {
  if (mutation.config.registerMappingKeys === undefined) return [];
  return mutation.config.registerMappingKeys({
    args: mutation.args,
    signature: mutation.signature,
    resolution: mutation.resolution,
  });
}

function createRevmRevertError(
  config: FFCAConfig,
  data: Hex.Hex | undefined,
  message = "revm execute reverted",
): ContractFunctionRevertedError {
  return new ContractFunctionRevertedError({
    abi: config.abi,
    data,
    functionName: "execute",
    message,
    cause: new RawContractError({ data, message }),
  });
}

export function createRuntimeEffect<const C extends FFCAConfig>(
  config: C,
  schema: Record<string, PgTable>,
): Effect.Effect<
  RuntimeFFCA<C>,
  unknown,
  Database | Rpc | Watch | Scope.Scope
> {
  return Effect.gen(function* () {
    const rpc = yield* Rpc;
    const db = yield* Database;
    const scope = yield* Scope.Scope;
    const bundleOrder =
      config.sequencing !== undefined && "bundleOrder" in config.sequencing
        ? config.sequencing.bundleOrder
        : undefined;

    const domain: TypedData.Domain = {
      name: config.domain.name,
      version: config.domain.version,
      chainId: config.chainId,
      verifyingContract: config.address,
    };

    const sequencingOrder = config.sequencing?.order ?? "fifo";
    const sequencing = {
      order: sequencingOrder,
      bundleIntervalMs:
        sequencingOrder === "bundle" &&
        config.sequencing !== undefined &&
        "bundleIntervalMs" in config.sequencing
          ? (config.sequencing.bundleIntervalMs ?? DEFAULT_BUNDLE_INTERVAL_MS)
          : DEFAULT_BUNDLE_INTERVAL_MS,
      submitIntervalMs:
        config.sequencing?.submitIntervalMs ?? DEFAULT_SUBMIT_INTERVAL_MS,
    };
    const confirmations = {
      safeBlockDepth: config.confirmations?.safeBlockDepth ?? 1,
      finalizedBlockDepth: config.confirmations?.finalizedBlockDepth ?? 5,
    };
    const mutationsByTag = new Map<
      number,
      { name: string; config: FFCAMutationConfig }
    >();
    for (const [name, mutation] of Object.entries(config.mutations)) {
      mutationsByTag.set(mutation.tag, { name, config: mutation });
    }

    const rpcUrl = Array.isArray(config.rpcUrl)
      ? config.rpcUrl[0]!
      : config.rpcUrl;
    // viem's `extractChain` is typed with a literal-union of known chain ids;
    // we accept any number at the framework boundary and cast through.
    const chain = extractChain({
      chains: Object.values(chains),
      id: config.chainId as 1,
    });
    const transport = http(rpcUrl, { retryCount: 0 });
    const publicClient = createPublicClient({ chain, transport });
    const walletClient = createWalletClient({
      account: config.account,
      chain,
      transport,
    });
    let mutationId = 0;
    let bundleId = 0;
    const initialSlots = yield* db.transaction((tx) =>
      selectAccountStorage(tx, schema),
    );
    const knownPaths = yield* db.transaction((tx) =>
      selectKnownPaths(tx, schema),
    );

    mutationId = yield* selectNextMutationId(schema);
    bundleId = yield* selectNextBundleId(schema);

    // revm is a startup resource, not part of the background loop. Initialize
    // it before returning so `ffca.state` and `execute()` never race startup.
    const evm = yield* createEVM();
    const code = yield* rpc.request({
      method: "eth_getCode",
      params: [config.address, "latest"],
    });
    if (code === undefined || code === "0x") {
      yield* Effect.logWarning(
        `no contract code at config.address=${config.address}; ` +
          "revm code load skipped - runtime will continue but revm has no contract bytecode",
      );
      yield* evm.init({
        chain_id: config.chainId,
        accounts: { [config.address]: { storage: initialSlots } },
      });
    } else {
      yield* evm.init({
        chain_id: config.chainId,
        accounts: {
          [config.address]: {
            code,
            storage: initialSlots,
          },
        },
      });
    }

    const state = createStorageProxy(
      config.storageLayout as C["storageLayout"],
      async (slots) => {
        return Effect.runPromise(
          evm.readStorage({ address: config.address, slots }),
        );
      },
      knownPaths,
    );

    // Local nonce cache. Lazy-initialized on first use; incremented per submit.
    // TODO recover from gaps and chain divergence; per-key parallelism when
    //   the account model lands.
    let txNonce = -1;
    const nextNonce = async (): Promise<number> => {
      if (txNonce === -1) {
        txNonce = await publicClient.getTransactionCount({
          address: config.account.address,
          blockTag: "pending",
        });
      }
      return txNonce++;
    };

    const mutationQueue =
      yield* Queue.unbounded<SubmittedMutationWithDeferred>();
    yield* Scope.addFinalizer(scope, Queue.shutdown(mutationQueue));

    const submitQueue = yield* Queue.unbounded<RuntimeBundle>();
    yield* Scope.addFinalizer(scope, Queue.shutdown(submitQueue));

    const pendingSubmissions = new Set<
      Deferred.Deferred<RuntimeMutation, unknown>
    >();
    yield* Scope.addFinalizer(
      scope,
      Effect.forEach(
        pendingSubmissions,
        (deferred) =>
          Deferred.fail(deferred, new Error("FFCA runtime stopped")),
        { discard: true },
      ).pipe(Effect.ignore),
    );

    let enqueuedMutations: EnqueuedMutation[] = [];
    let unfinalizedBlocks: RuntimeBlock[] = [];

    // The sidecar's commitJournal marks one journal as committed, so acceptance
    // must not open more journals while a submit pass is broadcasting and
    // committing. submit commits each bundle's journal individually after
    // broadcast succeeds.
    const withJournalLock = Semaphore.withPermits(Semaphore.makeUnsafe(1), 1);

    // Event fan-out. Listeners are in-process; HTTP / SSE shaping is the app's
    // job. A throwing listener is swallowed so it can't take the runtime down.
    const mutationListeners = new Set<MutationListener>();
    const bundleListeners = new Set<BundleListener>();
    const blockListeners = new Set<BlockListener>();
    const emitMutation = (event: MutationEvent) => {
      for (const cb of mutationListeners) {
        try {
          cb(event);
        } catch {}
      }
    };
    const emitBundle = (event: BundleEvent) => {
      for (const cb of bundleListeners) {
        try {
          cb(event);
        } catch {}
      }
    };
    const emitBlock = (event: BlockEvent) => {
      for (const cb of blockListeners) {
        try {
          cb(event);
        } catch {}
      }
    };

    let bundlePosition = 0;

    // Accept a set of queued mutations as one offchain bundle, then hand it to
    // submit. FIFO calls this with one mutation immediately; bundle mode calls
    // it with a sorted interval batch.
    const acceptBundle = (
      submittedMutations: SubmittedMutationWithDeferred[],
      position: number,
    ) =>
      withJournalLock(
        Effect.gen(function* () {
          if (
            submittedMutations.length === 0 &&
            enqueuedMutations.length === 0
          ) {
            return;
          }

          const acceptedMutations: {
            mutation: Extract<
              RuntimeMutation,
              { status: "accepted" | "included" | "safe" | "finalized" }
            >;
            slotWrites: ExecuteResult["slot_writes"];
            knownPaths: readonly string[];
            deferred: (typeof submittedMutations)[number]["deferred"];
          }[] = [];
          const rejectedMutations: {
            mutation: Extract<RuntimeMutation, { status: "rejected" }>;
            deferred: (typeof submittedMutations)[number]["deferred"];
            error: unknown;
          }[] = [];

          // Process force inclusions only if bundle is first in the block.
          // It's an invariant that a previous journal was committed with an
          // "enqueue()" transactions.

          const shouldForceExecute =
            position === 0 && enqueuedMutations.length > 0;

          if (shouldForceExecute) {
            const executeForceInclusionCalldata = yield* Effect.try({
              try: () =>
                encodeExecuteCalldata(
                  config.abi,
                  [],
                  enqueuedMutations.map(({ index }) => index),
                ),
              catch: (error) => error as Error,
            });

            // TODO(kyle) remove failing force inclusions
            yield* evm.beginJournal();
            const result = yield* evm.execute({
              from: config.account.address,
              to: config.address,
              data: executeForceInclusionCalldata,
            });
            if (result.success === false) {
              yield* evm.revertJournal();
            }

            enqueuedMutations = [];
          }

          // Open a revm journal for this bundle. Per-mutation executes record into
          // it on TS success; if the whole bundle is rejected we pop it below.
          // Successful bundles are left open and committed by submit's
          // `commitJournal` after the broadcast lands.
          yield* evm.beginJournal();

          // revm is the primary acceptance gate. `resolve` computes any extra
          // calldata, then revm executes the mutation against local EVM state.
          for (const { mutation, deferred } of submittedMutations) {
            const mutationResult = yield* Effect.result(
              Effect.gen(function* () {
                const resolution = yield* Effect.tryPromise({
                  try: () => resolveMutation(mutation, state),
                  catch: (error) => error as Error,
                });

                const acceptedMutation = {
                  ...mutation,
                  status: "accepted" as const,
                  isForceInclusion: false,
                  resolution,
                } as const satisfies Extract<
                  RuntimeMutation,
                  { status: "accepted" | "included" | "safe" | "finalized" }
                >;

                const knownPaths = yield* Effect.tryPromise({
                  try: () => registerKnownPaths(acceptedMutation),
                  catch: (error) => error as Error,
                });

                // Build single-mutation `execute(Bundle[], uint256[])` calldata.
                // The chain batches many of these per submit, but revm gets one
                // per accepted mutation for granular state evolution.
                const mutationCalldata = yield* Effect.try({
                  try: () =>
                    encodeExecuteCalldata(
                      config.abi,
                      [encodeBundleArg(config.abi, [acceptedMutation])],
                      [],
                    ),
                  catch: (error) => error as Error,
                });
                const result = yield* evm.execute({
                  from: config.account.address,
                  to: config.address,
                  data: mutationCalldata,
                });
                if (result.success === false) {
                  return yield* Effect.fail(
                    createRevmRevertError(config, result.revert_data),
                  );
                }
                return {
                  mutation: acceptedMutation,
                  slotWrites: result.slot_writes.filter(
                    (write) =>
                      write.address.toLowerCase() ===
                      config.address.toLowerCase(),
                  ),
                  knownPaths,
                };
              }),
            );

            if (Result.isSuccess(mutationResult)) {
              acceptedMutations.push({
                mutation: mutationResult.success.mutation,
                slotWrites: mutationResult.success.slotWrites,
                knownPaths: mutationResult.success.knownPaths,
                deferred,
              });
            } else {
              const rejectedMutation = {
                ...mutation,
                status: "rejected",
                isForceInclusion: false,
                error: mutationResult.failure,
              } as const satisfies Extract<
                RuntimeMutation,
                { status: "rejected" }
              >;

              rejectedMutations.push({
                mutation: rejectedMutation,
                deferred,
                error: mutationResult.failure,
              });
            }
          }

          for (const { mutation, deferred, error } of rejectedMutations) {
            emitMutation(mutationToEvent(mutation));
            yield* Deferred.fail(deferred, error);
          }

          if (acceptedMutations.length === 0) {
            // Nothing landed; drop the journal we opened above so submit's
            // `commitJournal` doesn't see a leftover empty journal.
            yield* evm.revertJournal();
            return;
          }

          const bundle = {
            status: "accepted",
            id: bundleId++,
            position,
            mutations: acceptedMutations.map(({ mutation }) => mutation),
          } as const satisfies RuntimeBundle;

          for (const {
            mutation,
            slotWrites,
            knownPaths,
            deferred,
          } of acceptedMutations) {
            yield* db.transaction((tx) =>
              Effect.gen(function* () {
                yield* insertMutation(tx, schema, mutation, bundle);
                yield* insertSlotWrites(tx, schema, mutation, slotWrites);
                yield* insertKnownPaths(tx, schema, knownPaths);
              }),
            );

            emitMutation(mutationToEvent(mutation));
            yield* Deferred.succeed(deferred, mutation);
          }

          emitBundle(bundleToEvent(bundle));
          yield* Queue.offer(submitQueue, bundle);
        }),
      );

    // submit: drain bundle queue, build calldata, broadcast to chain.
    // Single-RPC for now; multiplexing is a future step.
    // TODO error policy: an RPC failure that survives retry fails the submit
    //   fiber. The bundle's mutation Deferreds have already been resolved as
    //   "accepted", so callers don't see this. Real fix is per-bundle status
    //   updates + event fan-out.
    const submit = withJournalLock(
      Effect.gen(function* () {
        bundlePosition = 0;
        const bundles = yield* Queue.clear(submitQueue);
        if (bundles.length === 0) return;

        const rpcRetry = Effect.retry({
          times: 8,
          schedule: Schedule.spaced(Duration.millis(200)),
        });

        const args = bundles.map((b) =>
          encodeBundleArg(config.abi, b.mutations),
        );
        const forceExecuteIndexes: bigint[] = [];
        const calldata = encodeExecuteCalldata(
          config.abi,
          args,
          forceExecuteIndexes,
        );

        const simulateResult = yield* evm.simulate({
          from: config.account.address,
          to: config.address,
          data: calldata,
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

        const { accessList } = yield* Effect.tryPromise({
          try: () =>
            publicClient.createAccessList({
              account: config.account.address,
              to: config.address,
              data: calldata,
            }),
          catch: (error) => error as Error,
        }).pipe(rpcRetry);

        yield* Effect.tryPromise({
          try: () =>
            publicClient.estimateGas({
              account: config.account.address,
              to: config.address,
              data: calldata,
              accessList,
            }),
          catch: (error) => error as Error,
        }).pipe(rpcRetry);

        const nonce = yield* Effect.tryPromise({
          try: () => nextNonce(),
          catch: (error) => error as Error,
        }).pipe(rpcRetry);

        const request = yield* Effect.tryPromise({
          try: () =>
            walletClient.prepareTransactionRequest({
              to: config.address,
              data: calldata,
              accessList: simulateResult.access_list,
              gas: BigInt(simulateResult.gas_limit),
              nonce,
            }),
          catch: (error) => error as Error,
        }).pipe(rpcRetry);

        const signed = yield* Effect.tryPromise({
          try: () => walletClient.signTransaction(request),
          catch: (error) => error as Error,
        });

        const transactionHash = keccak256(signed);

        const receipt = yield* Effect.tryPromise({
          try: () =>
            sendRawTransactionSync(walletClient, {
              serializedTransaction: signed,
              throwOnReceiptRevert: true,
            }),
          catch: (error) => error as Error,
        });

        // Sidecar commit marks the top journal committed without popping it.
        // Once the newest drained bundle is committed, older journals below it
        // are no longer part of the uncommitted suffix considered by simulate.
        yield* evm.commitJournal();

        const block = yield* Effect.tryPromise({
          try: () => publicClient.getBlock({ blockHash: receipt.blockHash }),
          catch: (error) => error as Error,
        }).pipe(rpcRetry);

        for (const bundle of bundles) {
          bundle.status = "included";
          for (const mutation of bundle.mutations) {
            mutation.status = "included";
          }
        }

        const runtimeBlock: RuntimeBlock = {
          status: "included",
          number: block.number,
          hash: block.hash,
          timestamp: block.timestamp,
          transactionHash,
          bundles,
          enqueues: [],
          forceExecutes: [],
        };

        yield* Effect.logInfo("bundles included").pipe(
          Effect.annotateLogs({
            bundleIds: bundles.map((b) => b.id),
            bundleCount: bundles.length,
            forceExecuteIndexes: forceExecuteIndexes.map((index) =>
              index.toString(),
            ),
            mutationCount: bundles.reduce((n, b) => n + b.mutations.length, 0),
            blockNumber: block.number.toString(),
            transactionHash,
          }),
        );

        for (const bundle of bundles) {
          for (const mutation of bundle.mutations) {
            yield* db.transaction((tx) =>
              updateMutationLifecycle(tx, schema, {
                ...mutation,
                status: "included",
                block: runtimeBlock,
              }),
            );
          }
        }

        emitBlock(blockToEvent(runtimeBlock));
        for (const bundle of bundles) {
          emitBundle(bundleToEvent(bundle));
          for (const mutation of bundle.mutations)
            emitMutation(mutationToEvent(mutation));
        }

        unfinalizedBlocks.push(runtimeBlock);
      }),
    );

    const watch = Effect.gen(function* () {
      const watchService = yield* Watch;
      yield* watchService.messages.pipe(
        Stream.runForEach((message) =>
          Effect.gen(function* () {
            if (message._tag === "Reorged") {
              for (const block of unfinalizedBlocks) {
                for (const bundle of block.bundles) {
                  const isReorged = message.reorgedBlocks.some((r) =>
                    r.transactions.includes(block.transactionHash),
                  );
                  if (isReorged) {
                    const reIncludedBlock = message.newBlocks.find((r) =>
                      r.transactions.includes(block.transactionHash),
                    );

                    if (reIncludedBlock === undefined) {
                      return yield* Effect.fail(
                        new Error(
                          `reorged bundle removed from canonical chain: bundleId=${bundle.id} transactionHash=${block.transactionHash}`,
                        ),
                      );
                    } else {
                      yield* Effect.logInfo(
                        "reorged bundle was re-included",
                      ).pipe(
                        Effect.annotateLogs({
                          bundleId: bundle.id,
                          transactionHash: block.transactionHash,
                        }),
                      );
                    }
                  }
                }
              }

              return;
            }

            yield* withJournalLock(
              Effect.gen(function* () {
                for (const log of message.block.logs) {
                  const decodedLog = decodeEventLog({
                    abi: config.abi as FFCAAbi,
                    eventName: "ForceInclusionQueued",
                    // @ts-expect-error
                    topics: log.topics,
                    data: log.data,
                    strict: true,
                  });

                  // TODO(kyle) validate mutation against zod

                  const mutationNameAndConfig = mutationsByTag.get(
                    decodedLog.args.mutation,
                  )!;

                  const enqueuedMutation: Extract<
                    RuntimeMutation,
                    { status: "enqueued" }
                  > = {
                    status: "enqueued",
                    id: 0,
                    index: decodedLog.args.index,
                    name: mutationNameAndConfig.name,
                    config: mutationNameAndConfig.config,
                    signature: decodedLog.args.sig,
                    ...decodeMutationCalldata(
                      mutationNameAndConfig.config,
                      decodedLog.args.mutationData,
                    ),
                  };

                  const enqueueCalldata = encodeEnqueueCalldata(
                    config.abi,
                    enqueuedMutation,
                  );

                  yield* evm.beginJournal();
                  const result = yield* evm.execute({
                    from: "0x0000000000000000000000000000000000000000",
                    to: config.address,
                    data: enqueueCalldata,
                  });

                  if (result.success === false) {
                    yield* evm.revertJournal();
                  } else {
                    yield* evm.commitJournal();
                  }

                  enqueuedMutations.push(enqueuedMutation);
                }
              }),
            );

            for (const blockEvent of unfinalizedBlocks.filter(
              (block) => block.number < message.block.number,
            )) {
              const blockDepth = message.block.number - blockEvent.number;
              let nextStatus: "safe" | "finalized" | undefined;

              if (
                blockDepth >= BigInt(confirmations.finalizedBlockDepth) &&
                blockEvent.status !== "finalized"
              ) {
                nextStatus = "finalized";
              } else if (
                blockDepth >= BigInt(confirmations.safeBlockDepth) &&
                blockEvent.status !== "safe" &&
                blockEvent.status !== "finalized"
              ) {
                nextStatus = "safe";
              }

              if (nextStatus === undefined) continue;

              blockEvent.status = nextStatus;
              for (const bundle of blockEvent.bundles) {
                bundle.status = nextStatus;
                for (const mutation of bundle.mutations) {
                  mutation.status = nextStatus;
                }
              }

              for (const bundle of blockEvent.bundles) {
                for (const mutation of bundle.mutations) {
                  yield* db.transaction((tx) =>
                    updateMutationLifecycle(tx, schema, {
                      ...mutation,
                      status: nextStatus,
                    }),
                  );
                }
              }

              emitBlock(blockEvent);
              for (const bundle of blockEvent.bundles) {
                emitBundle(bundle);
                for (const mutation of bundle.mutations) {
                  emitMutation(mutation);
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

    const fifoBundleProgram = Effect.forever(
      Effect.gen(function* () {
        // TODO(kyle) mutation should immeditately process the force inclusion
        const item = yield* Queue.take(mutationQueue);

        yield* acceptBundle([item], bundlePosition++);
      }),
    );

    const sequencedBundleProgram = Effect.repeat(
      Effect.gen(function* () {
        const queued = yield* Queue.clear(mutationQueue);
        if (queued.length === 0) return;

        if (bundleOrder === undefined) {
          return yield* Effect.fail(
            new Error(
              "config.sequencing.bundleOrder is required for bundle ordering",
            ),
          );
        }
        const order = bundleOrder;
        queued.sort(
          (a, b) =>
            order.indexOf(a.mutation.name) - order.indexOf(b.mutation.name),
        );

        yield* acceptBundle(queued, bundlePosition++);
      }),
      Schedule.fixed(Duration.millis(sequencing.bundleIntervalMs)),
    );

    const bundleProgram =
      sequencing.order === "fifo" ? fifoBundleProgram : sequencedBundleProgram;

    const closeOnFatalExit = (
      name: string,
      exit: Exit.Exit<unknown, unknown>,
    ) =>
      Effect.gen(function* () {
        if (Exit.isSuccess(exit)) return;
        if (
          Exit.hasInterrupts(exit) &&
          !Exit.hasFails(exit) &&
          !Exit.hasDies(exit)
        ) {
          return;
        }

        const cause = exit.cause;
        yield* Effect.logError(`ffca ${name} fiber failed`).pipe(
          Effect.annotateLogs({ cause: Cause.pretty(cause) }),
        );
        for (const deferred of pendingSubmissions) {
          yield* Deferred.failCause(deferred, cause);
        }

        yield* Effect.sync(() => {
          setTimeout(() => {
            void Effect.runPromise(
              Scope.close(scope, Exit.failCause(cause)).pipe(Effect.ignore),
            ).finally(() => {
              setTimeout(() => {
                throw Cause.squash(cause);
              }, 0);
            });
          }, 0);
        });
      });

    const forkRuntimeFiber = <A, R>(
      name: string,
      effect: Effect.Effect<A, unknown, R>,
    ) =>
      Effect.forkScoped(
        effect.pipe(Effect.onExit((exit) => closeOnFatalExit(name, exit))),
      );

    const submitProgram = Effect.sleep(
      Duration.millis(sequencing.submitIntervalMs),
    ).pipe(
      Effect.andThen(
        Effect.repeat(
          submit,
          Schedule.fixed(Duration.millis(sequencing.submitIntervalMs)),
        ),
      ),
    );

    yield* Effect.logInfo("ffca runtime started").pipe(
      Effect.provide(Logger.layer([Logger.formatJson])),
    );
    yield* forkRuntimeFiber("bundle", bundleProgram);
    yield* forkRuntimeFiber("submit", submitProgram);
    yield* forkRuntimeFiber("watch", watch);

    function execute(
      mutation: SubmittedMutation,
    ): Effect.Effect<MutationEvent, unknown> {
      return Effect.gen(function* () {
        // TODO(kyle) run `mutation` through zod to check shape

        const mutationConfig = config.mutations[mutation.name]!;

        const runtimeMutation = {
          ...mutation,
          id: mutationId++,
          status: "submitted",
          config: mutationConfig,
        } as const satisfies Extract<RuntimeMutation, { status: "submitted" }>;

        emitMutation(mutationToEvent(runtimeMutation));

        const deferred = yield* Deferred.make<RuntimeMutation, unknown>();
        pendingSubmissions.add(deferred);
        return yield* Effect.gen(function* () {
          yield* Queue.offer(mutationQueue, {
            mutation: runtimeMutation,
            deferred,
          });
          return yield* Deferred.await(deferred);
        }).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              pendingSubmissions.delete(deferred);
            }),
          ),
        );
      }).pipe(Effect.provide(Logger.layer([Logger.formatJson])));
    }

    function on(
      event: "mutation",
      cb: MutationListener,
    ): Effect.Effect<() => void>;
    function on(event: "bundle", cb: BundleListener): Effect.Effect<() => void>;
    function on(event: "block", cb: BlockListener): Effect.Effect<() => void>;
    function on(
      event: "mutation" | "bundle" | "block",
      cb: MutationListener | BundleListener | BlockListener,
    ): Effect.Effect<() => void> {
      return Effect.sync(() => {
        if (event === "mutation") {
          const listener = cb as MutationListener;
          mutationListeners.add(listener);
          return () => mutationListeners.delete(listener);
        }
        if (event === "bundle") {
          const listener = cb as BundleListener;
          bundleListeners.add(listener);
          return () => bundleListeners.delete(listener);
        }
        const listener = cb as BlockListener;
        blockListeners.add(listener);
        return () => blockListeners.delete(listener);
      });
    }

    return {
      state,
      schema: schema as FFCASchema<C>,
      domain,
      execute,
      on,
    };
  });
}
