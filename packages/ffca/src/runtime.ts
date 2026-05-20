import { sql } from "drizzle-orm";
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
import type { SqlError } from "effect/unstable/sql/SqlError";
import { createEVM } from "evm";
import { AbiParameters, type Hex, TypedData } from "ox";
import {
  type AccountStorage,
  createStorageProxy,
  encodeStorage,
  type StorageLayout,
  type StorageLayoutToPrimitiveType,
} from "storage-layout";
import {
  ContractFunctionRevertedError,
  createPublicClient,
  createWalletClient,
  decodeEventLog,
  encodeFunctionData,
  extractChain,
  http,
  keccak256,
  RawContractError,
} from "viem";
import { sendRawTransactionSync } from "viem/actions";
import * as chains from "viem/chains";
import type { BundleView, FFCAConfig, FFCAMutationConfig } from "./config";
import { Database } from "./db";
import { buildEip712Types, hashMutationEip712 } from "./eip712";
import {
  decodeMutationCalldata,
  encodeBundleArg,
  executeAbi,
  forceInclusionQueuedAbi,
} from "./encoding";
import {
  PersistenceError,
  persistAcceptedBundle,
  persistBlockLifecycle,
  persistIncludedBundles,
} from "./persistence";
import { Rpc } from "./rpc";
import type {
  AnchoredBundle,
  BlockEvent,
  BundleEvent,
  MutationEvent,
  ResolvedMutation,
  SubmittedMutation,
  SubmittedMutationEvent,
} from "./types";
import { type LocalLog, Watch } from "./watch";

// TODO sequencing: name-list works (config.sequence). Next is a state-aware
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
const DEFAULT_BLOCK_POLLING_INTERVAL_MS = 200;
const DEFAULT_SAFE_BLOCK_DEPTH = 1;
const DEFAULT_FINALIZED_BLOCK_DEPTH = 5;

type MutationListener = (event: MutationEvent) => void;
type BundleListener = (event: BundleEvent) => void;
type BlockListener = (event: BlockEvent) => void;

type QueuedMutation = {
  submitted: SubmittedMutationEvent;
  deferred: Deferred.Deferred<MutationEvent, unknown>;
};

type PendingForceInclusion = {
  index: bigint;
  mutation: Extract<ResolvedMutation, { status: "accepted" }>;
};

type AcceptedBundleWithForce = Extract<BundleEvent, { status: "accepted" }> & {
  forceExecuteIndexes?: bigint[];
};

type UnfinalizedBlock = Exclude<BlockEvent, { status: "accepted" }>;

type AsyncStorageProxy<T> = [T] extends [readonly unknown[]]
  ? { readonly [K in keyof T]: AsyncStorageProxy<T[K]> }
  : [T] extends [object]
    ? { readonly [K in keyof T]: AsyncStorageProxy<T[K]> }
    : Promise<T>;

export type FFCA<L extends StorageLayout = never> = {
  readonly state: [L] extends [never]
    ? unknown
    : AsyncStorageProxy<StorageLayoutToPrimitiveType<L>>;
  readonly domain: TypedData.Domain;
  execute(submitted: SubmittedMutation): Promise<MutationEvent>;
  on(event: "mutation", cb: MutationListener): () => void;
  on(event: "bundle", cb: BundleListener): () => void;
  on(event: "block", cb: BlockListener): () => void;
  stop(): Promise<void>;
};

export type RuntimeFFCA<L extends StorageLayout = never> = {
  readonly state: [L] extends [never]
    ? unknown
    : AsyncStorageProxy<StorageLayoutToPrimitiveType<L>>;
  readonly domain: TypedData.Domain;
  execute(submitted: SubmittedMutation): Effect.Effect<MutationEvent, unknown>;
  on(event: "mutation", cb: MutationListener): Effect.Effect<() => void>;
  on(event: "bundle", cb: BundleListener): Effect.Effect<() => void>;
  on(event: "block", cb: BlockListener): Effect.Effect<() => void>;
};

// State-independent half of mutation verification.
//
// TODO when the account model is real, add a state-dependent companion that
//   does: signature recovery + key-type dispatch (P256 / WebAuthn / secp256k1),
//   key lookup, key-expiry check, nonce sequence check, and deadline check.
//   The deadline check is skipped here because where `deadline` lives in
//   args/envelope isn't decided yet.
//   See apps/order-book/src/signature.ts:135-260.
export function verifyMutation(
  mutation: FFCAMutationConfig,
  signatureParams: readonly AbiParameters.Parameter[],
  submitted: SubmittedMutation,
  domain: TypedData.Domain,
): Hex.Hex {
  const { name, args } = submitted;
  if (args === null || typeof args !== "object") {
    throw new Error(`args must be an object (mutation=${name})`);
  }
  const argsRecord = args as Record<string, unknown>;
  for (const param of mutation.params) {
    if (param.name && !(param.name in argsRecord)) {
      throw new Error(`missing field: ${param.name} (mutation=${name})`);
    }
  }

  TypedData.assert({
    domain,
    types: buildEip712Types(mutation, name),
    primaryType: name,
    message: argsRecord,
  });

  verifyAbiRecord("signature", signatureParams, submitted.signature, name);
  return hashMutationEip712(mutation, name, argsRecord, domain);
}

export function verifyResolution(
  mutation: FFCAMutationConfig,
  resolution: unknown,
  name: string,
): void {
  if ("resolution" in mutation) {
    verifyAbiRecord("resolution", mutation.resolution, resolution, name);
  }
}

function verifyAbiRecord(
  label: string,
  params: readonly AbiParameters.Parameter[],
  value: unknown,
  mutationName: string,
): void {
  if (value === null || typeof value !== "object") {
    throw new Error(`${label} must be an object (mutation=${mutationName})`);
  }

  const record = value as Record<string, unknown>;
  for (const param of params) {
    if (param.name && !(param.name in record)) {
      throw new Error(
        `missing ${label} field: ${param.name} (mutation=${mutationName})`,
      );
    }
  }

  AbiParameters.encode(
    params,
    params.map((param) => record[param.name ?? ""]),
  );
}

async function resolveMutation(
  config: FFCAMutationConfig,
  args: unknown,
  signature: unknown,
  state: unknown,
  bundle: BundleView,
): Promise<unknown> {
  if ("resolve" in config) {
    return config.resolve({ state, args, signature, bundle });
  }
  return undefined;
}

function createRevmRevertError(
  config: FFCAConfig,
  data: Hex.Hex | undefined,
): ContractFunctionRevertedError {
  const message = "revm execute reverted";
  return new ContractFunctionRevertedError({
    abi: config.abi as never,
    data,
    functionName: "execute",
    message,
    cause: new RawContractError({ data, message }),
  });
}

function blockDepth(value: number | undefined, fallback: number, name: string) {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a safe non-negative integer`);
  }
  return value;
}

function loadNextIds(
  config: FFCAConfig,
): Effect.Effect<
  { mutationId: number; bundleId: number },
  PersistenceError | SqlError,
  Database
> {
  return Effect.gen(function* () {
    const db = yield* Database;
    let maxMutationId = -1;
    let maxBundleId = -1;
    for (const mutation of Object.values(config.mutations)) {
      // biome-ignore lint/suspicious/noExplicitAny: mutation tables share ffca's id column by convention
      const table = mutation.table as any;
      const [row] = yield* db
        .select({
          maxMutationId: sql<number>`coalesce(max(${table.id}), -1)`,
          maxBundleId: sql<number>`coalesce(max(${table.bundleId}), -1)`,
        })
        .from(mutation.table as PgTable);
      if (row !== undefined && row.maxMutationId > maxMutationId) {
        maxMutationId = row.maxMutationId;
      }
      if (row !== undefined && row.maxBundleId > maxBundleId) {
        maxBundleId = row.maxBundleId;
      }
    }
    return { mutationId: maxMutationId + 1, bundleId: maxBundleId + 1 };
  }).pipe(
    Effect.mapError(
      (cause) =>
        new PersistenceError({
          message: "Failed to load FFCA persistence ids",
          cause,
        }),
    ),
  );
}

export function createRuntimeEffect<const C extends FFCAConfig>(
  config: C,
  schema: Record<string, PgTable> | undefined,
): Effect.Effect<
  RuntimeFFCA<C["storageLayout"]>,
  unknown,
  Database | Rpc | Watch | Scope.Scope
> {
  return Effect.gen(function* () {
    const rpc = yield* Rpc;
    const db = yield* Database;
    const scope = yield* Scope.Scope;

    const domain: TypedData.Domain = {
      name: config.domain.name,
      version: config.domain.version,
      chainId: config.chainId,
      verifyingContract: config.address,
    };

    const sequencingOrder =
      config.sequencing?.order ??
      (config.sequence === undefined ? "fifo" : "bundle");
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
      blockPollingIntervalMs:
        config.sequencing?.blockPollingIntervalMs ??
        DEFAULT_BLOCK_POLLING_INTERVAL_MS,
    };
    const confirmations = {
      safeBlockDepth: blockDepth(
        config.confirmations?.safeBlockDepth,
        DEFAULT_SAFE_BLOCK_DEPTH,
        "config.confirmations.safeBlockDepth",
      ),
      finalizedBlockDepth: blockDepth(
        config.confirmations?.finalizedBlockDepth,
        DEFAULT_FINALIZED_BLOCK_DEPTH,
        "config.confirmations.finalizedBlockDepth",
      ),
    };
    if (confirmations.finalizedBlockDepth < confirmations.safeBlockDepth) {
      throw new Error(
        "config.confirmations.finalizedBlockDepth must be greater than or equal to config.confirmations.safeBlockDepth",
      );
    }

    if (sequencing.order === "bundle" && config.sequence === undefined) {
      throw new Error("config.sequence is required for bundle ordering");
    }

    const mutationsByTag = new Map<
      number,
      { name: string; config: FFCAMutationConfig }
    >();
    for (const [name, mutation] of Object.entries(config.mutations)) {
      if (mutationsByTag.has(mutation.tag)) {
        throw new Error(`duplicate mutation tag: ${mutation.tag}`);
      }
      mutationsByTag.set(mutation.tag, { name, config: mutation });
    }

    const rpcUrls = Array.isArray(config.rpcUrl)
      ? config.rpcUrl
      : [config.rpcUrl];
    const rpcUrl = rpcUrls[0];
    if (rpcUrl === undefined) {
      throw new Error("At least one RPC URL is required");
    }
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
    const executionAbi = executeAbi(config.signature.params);
    const forceInclusionAbi = forceInclusionQueuedAbi(config.signature.params);

    let mutationId = 0;
    let bundleId = 0;
    let initialSlots: AccountStorage = {};

    if (schema !== undefined) {
      const load = config.state?.load;
      if (load === undefined) {
        return yield* new PersistenceError({
          message: "FFCA persistence state.load is required",
        });
      }

      const initialState = yield* db.transaction(load);
      initialSlots = encodeStorage(config.storageLayout, initialState as never);

      const ids = yield* loadNextIds(config);
      mutationId = ids.mutationId;
      bundleId = ids.bundleId;
    }

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

    const state = createStorageProxy(config.storageLayout, async (slots) => {
      return Effect.runPromise(
        evm.readStorage({ address: config.address, slots }),
      );
    });

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

    const mutationQueue = yield* Queue.unbounded<QueuedMutation>();
    yield* Scope.addFinalizer(scope, Queue.shutdown(mutationQueue));
    const submitQueue = yield* Queue.unbounded<BundleEvent>();
    yield* Scope.addFinalizer(scope, Queue.shutdown(submitQueue));
    const pendingForceInclusions: PendingForceInclusion[] = [];
    const seenForceInclusionIndexes = new Set<string>();
    // The sidecar's commitBundles drains every open journal, so acceptance must
    // not open more journals while a submit pass is broadcasting and committing.
    const withJournalLock = Semaphore.withPermits(Semaphore.makeUnsafe(1), 1);
    let unfinalizedBlocks: UnfinalizedBlock[] = [];

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

    const decodeForceInclusionLog = (log: LocalLog): PendingForceInclusion => {
      const decoded = decodeEventLog({
        abi: forceInclusionAbi,
        eventName: "ForceInclusionQueued",
        data: log.data,
        topics: log.topics as [`0x${string}`, ...`0x${string}`[]],
      });
      const args = decoded.args as {
        index: bigint;
        mutation: number;
        mutationData: Hex.Hex;
        sig: unknown;
      };
      const mutation = mutationsByTag.get(args.mutation);
      if (mutation === undefined) {
        throw new Error(
          `unknown force-inclusion mutation tag: ${args.mutation}`,
        );
      }
      const { args: mutationArgs, resolution } = decodeMutationCalldata(
        mutation.config,
        args.mutationData,
      );
      const submitted = {
        name: mutation.name,
        args: mutationArgs,
        signature: args.sig,
      };
      const digest = verifyMutation(
        mutation.config,
        config.signature.params,
        submitted,
        domain,
      );
      verifyResolution(mutation.config, resolution, mutation.name);

      const accepted = {
        ...submitted,
        id: mutationId++,
        status: "accepted" as const,
        digest,
        config: mutation.config,
        resolution,
      };
      return { index: args.index, mutation: accepted };
    };

    // Accept a set of queued mutations as one offchain bundle, then hand it to
    // submit. FIFO calls this with one mutation immediately; bundle mode calls
    // it with a sorted interval batch.
    const acceptBundle = (queued: QueuedMutation[], position: number) =>
      withJournalLock(
        Effect.gen(function* () {
          if (queued.length === 0) return;

          const accepted: Extract<MutationEvent, { status: "accepted" }>[] = [];
          const rejections: {
            item: (typeof queued)[number];
            error: unknown;
          }[] = [];

          // Snapshot the bundle's mutations for `resolve` to read. Built once;
          // doesn't reflect failures or mid-bundle state changes.
          const bundleView: BundleView = queued.map((q) => ({
            name: q.submitted.name,
            args: q.submitted.args,
          }));

          // Open a revm journal for this bundle. Per-mutation executes record into
          // it on TS success; if the whole bundle is rejected we pop it below.
          // Successful bundles are left open and committed by submit's
          // `commitBundles` after the broadcast lands.
          yield* evm.beginBundle();

          const forceInclusions =
            position === 0 ? pendingForceInclusions.slice() : [];
          const forceExecuteIndexes = forceInclusions.map(({ index }) => index);
          const forceMutations = forceInclusions.map(
            ({ mutation }) => mutation,
          );
          if (forceMutations.length > 0) {
            const forceCalldata = yield* Effect.try({
              try: () =>
                encodeFunctionData({
                  abi: executionAbi,
                  functionName: "execute",
                  args: [
                    [encodeBundleArg(forceMutations, config.signature.params)],
                    [],
                  ],
                }),
              catch: (error) => error as Error,
            });
            const result = yield* evm.execute({
              from: config.account.address,
              to: config.address,
              data: forceCalldata,
            });
            if (result.success === false) {
              yield* evm.revertBundle();
              return yield* Effect.fail(
                createRevmRevertError(config, result.revert_data),
              );
            }
          }

          // revm is the primary acceptance gate. `resolve` computes any extra
          // calldata, then revm executes the mutation against local EVM state.
          for (const item of queued) {
            const { config: mutationConfig, args, signature } = item.submitted;
            const attempted = yield* Effect.result(
              Effect.gen(function* () {
                const resolution = yield* Effect.tryPromise({
                  try: () =>
                    resolveMutation(
                      mutationConfig,
                      args,
                      signature,
                      state,
                      bundleView,
                    ),
                  catch: (error) => error as Error,
                });
                yield* Effect.try({
                  try: () =>
                    verifyResolution(
                      mutationConfig,
                      resolution,
                      item.submitted.name,
                    ),
                  catch: (error) => error as Error,
                });
                const acceptedMutation = {
                  ...item.submitted,
                  status: "accepted" as const,
                  resolution,
                };

                // Build single-mutation
                // `execute(Bundle[], uint256[])` calldata — the chain would batch
                // many of these per submit, but revm gets one per accepted mutation
                // for granular state evolution. Uses `executeAbi(sigParams)`
                // rather than `config.abi` so the encode doesn't depend on the
                // user's ABI containing an `execute` entry — the bundle shape is
                // an ffca convention.
                const mutationCalldata = yield* Effect.try({
                  try: () =>
                    encodeFunctionData({
                      abi: executeAbi(config.signature.params),
                      functionName: "execute",
                      args: [
                        [
                          encodeBundleArg(
                            [acceptedMutation],
                            config.signature.params,
                          ),
                        ],
                        [],
                      ],
                    }),
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
                return acceptedMutation;
              }),
            );
            if (Result.isSuccess(attempted)) {
              accepted.push(attempted.success);
            } else {
              rejections.push({ item, error: attempted.failure });
            }
          }

          for (const { item, error } of rejections) {
            const rejected: MutationEvent = {
              ...item.submitted,
              status: "rejected",
              error,
            };
            emitMutation(rejected);
            yield* Deferred.fail(item.deferred, error);
          }

          if (accepted.length === 0) {
            // Nothing landed; drop the journal we opened above so submit's
            // `commitBundles` doesn't see leftover empty bundles.
            yield* evm.revertBundle();
            return;
          }

          const bundleEvent: BundleEvent = {
            id: bundleId++,
            status: "accepted",
            position,
            mutations: accepted,
          };
          if (forceExecuteIndexes.length > 0) {
            (bundleEvent as AcceptedBundleWithForce).forceExecuteIndexes =
              forceExecuteIndexes;
            pendingForceInclusions.splice(0, forceInclusions.length);
          }

          yield* persistAcceptedBundle(bundleEvent);

          for (const a of accepted) {
            emitMutation(a);
            const item = queued.find((q) => q.submitted.id === a.id)!;
            yield* Deferred.succeed(item.deferred, a);
          }

          emitBundle(bundleEvent);
          emitBlock({ status: "accepted", bundles: [bundleEvent] });
          yield* Queue.offer(submitQueue, bundleEvent);
        }),
      );

    const sequencedBundle = Effect.gen(function* () {
      const queued = yield* Queue.clear(mutationQueue);
      if (queued.length === 0) return;

      const order = config.sequence!;
      queued.sort(
        (a, b) =>
          order.indexOf(a.submitted.name) - order.indexOf(b.submitted.name),
      );

      yield* acceptBundle(queued, bundlePosition++);
    });

    // submit: drain bundle queue, build calldata, broadcast to chain.
    // Single-RPC for now; multiplexing is a future step.
    // TODO error policy: an RPC failure that survives retry fails the submit
    //   fiber. The bundle's mutation Deferreds have already been resolved as
    //   "accepted", so callers don't see this. Real fix is per-bundle status
    //   updates + event fan-out.
    const submit = withJournalLock(
      Effect.gen(function* () {
        bundlePosition = 0;
        const accepted = yield* Queue.clear(submitQueue);
        if (accepted.length === 0) return;

        // submitQueue only holds AcceptedBundle today; narrow for the rest of
        // the body.
        const bundles = accepted as AcceptedBundleWithForce[];

        const rpcRetry = Effect.retry({
          times: 8,
          schedule: Schedule.spaced(Duration.millis(200)),
        });

        const args = bundles.map((b) =>
          encodeBundleArg(b.mutations, config.signature.params),
        );
        const forceExecuteIndexes = bundles.flatMap(
          (b) => b.forceExecuteIndexes ?? [],
        );
        const calldata = encodeFunctionData({
          abi: executionAbi,
          functionName: "execute",
          args: [args, forceExecuteIndexes],
        });

        yield* Effect.tryPromise({
          try: () =>
            publicClient.simulateContract({
              account: config.account.address,
              abi: executionAbi,
              address: config.address,
              functionName: "execute",
              args: [args, forceExecuteIndexes],
            }),
          catch: (error) => error as Error,
        }).pipe(rpcRetry);

        const { accessList } = yield* Effect.tryPromise({
          try: () =>
            publicClient.createAccessList({
              account: config.account.address,
              to: config.address,
              data: calldata,
            }),
          catch: (error) => error as Error,
        }).pipe(rpcRetry);

        const gasUsed = yield* Effect.tryPromise({
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
              accessList,
              gas: gasUsed + gasUsed / 100n,
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
            }),
          catch: (error) => error as Error,
        }).pipe(rpcRetry);

        // The journal lock guarantees the only open journals belong to the
        // accepted bundles drained above.
        yield* evm.commitBundles();

        const block = yield* Effect.tryPromise({
          try: () => publicClient.getBlock({ blockHash: receipt.blockHash }),
          catch: (error) => error as Error,
        }).pipe(rpcRetry);

        for (const bundle of bundles) {
          for (const mutation of bundle.mutations) {
            (mutation as ResolvedMutation).status = "included";
          }
          const anchoredBundle = bundle as unknown as AnchoredBundle;
          anchoredBundle.status = "included";
          anchoredBundle.number = block.number;
          anchoredBundle.hash = block.hash;
          anchoredBundle.transactionHash = transactionHash;
        }
        const anchored = bundles as unknown as AnchoredBundle[];

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

        const includedBlock: Exclude<BlockEvent, { status: "accepted" }> = {
          status: "included",
          number: block.number,
          hash: block.hash,
          timestamp: block.timestamp,
          bundles: anchored,
        };

        yield* persistIncludedBundles({
          bundles: anchored,
          block: {
            number: block.number,
            hash: block.hash,
            timestamp: block.timestamp,
          },
          transactionHash,
          calldata,
        });

        for (const b of anchored) {
          emitBundle(b);
          for (const m of b.mutations) emitMutation(m);
        }
        emitBlock(includedBlock);
        unfinalizedBlocks.push(includedBlock);
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
                  const isReorged = message.reorgedBlocks.some((block) =>
                    block.transactions.includes(bundle.transactionHash),
                  );
                  if (isReorged) {
                    const reIncludedBlock = message.newBlocks.find((block) =>
                      block.transactions.includes(bundle.transactionHash),
                    );

                    if (reIncludedBlock === undefined) {
                      return yield* Effect.fail(
                        new Error(
                          `reorged bundle removed from canonical chain: bundleId=${bundle.id} transactionHash=${bundle.transactionHash}`,
                        ),
                      );
                    } else {
                      yield* Effect.logInfo(
                        "reorged bundle was re-included",
                      ).pipe(
                        Effect.annotateLogs({
                          bundleId: bundle.id,
                          transactionHash: bundle.transactionHash,
                        }),
                      );
                    }
                  }
                }
              }

              return;
            }

            const detectedForceInclusions: PendingForceInclusion[] = [];
            for (const log of message.block.logs) {
              const forceInclusion = yield* Effect.try({
                try: () => decodeForceInclusionLog(log),
                catch: (error) => error as Error,
              });
              const key = forceInclusion.index.toString();
              if (seenForceInclusionIndexes.has(key)) continue;
              seenForceInclusionIndexes.add(key);
              detectedForceInclusions.push(forceInclusion);
            }
            if (detectedForceInclusions.length > 0) {
              yield* withJournalLock(
                Effect.sync(() => {
                  pendingForceInclusions.push(...detectedForceInclusions);
                }),
              );
              yield* Effect.logInfo("force inclusions detected").pipe(
                Effect.annotateLogs({
                  forceExecuteIndexes: detectedForceInclusions.map(
                    ({ index }) => index.toString(),
                  ),
                }),
              );
            }

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

              yield* persistBlockLifecycle(blockEvent);

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
        const item = yield* Queue.take(mutationQueue);
        yield* acceptBundle([item], bundlePosition++);
      }),
    );

    const sequencedBundleProgram = Effect.repeat(
      sequencedBundle,
      Schedule.fixed(Duration.millis(sequencing.bundleIntervalMs)),
    );

    const bundleProgram =
      sequencing.order === "fifo" ? fifoBundleProgram : sequencedBundleProgram;

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
    yield* Effect.forkScoped(bundleProgram);
    yield* Effect.forkScoped(submitProgram);
    yield* Effect.forkScoped(watch);

    function execute(
      submitted: SubmittedMutation,
    ): Effect.Effect<MutationEvent, unknown> {
      return Effect.gen(function* () {
        const mutation = config.mutations[submitted.name];
        if (mutation === undefined) {
          throw new Error(`unknown mutation: ${submitted.name}`);
        }
        if (
          sequencing.order === "bundle" &&
          !config.sequence!.includes(submitted.name)
        ) {
          throw new Error(`mutation not in sequence: ${submitted.name}`);
        }
        const digest = verifyMutation(
          mutation,
          config.signature.params,
          submitted,
          domain,
        );

        const submittedEvent: SubmittedMutationEvent = {
          ...submitted,
          id: mutationId++,
          status: "submitted",
          digest,
          config: mutation,
        };
        emitMutation(submittedEvent);
        const deferred = yield* Deferred.make<MutationEvent, unknown>();
        yield* Queue.offer(mutationQueue, {
          submitted: submittedEvent,
          deferred,
        });
        return yield* Deferred.await(deferred);
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
      state: state as RuntimeFFCA<C["storageLayout"]>["state"],
      domain,
      execute,
      on,
    };
  });
}
