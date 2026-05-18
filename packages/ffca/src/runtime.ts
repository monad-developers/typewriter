import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sql";
import type { PgTable } from "drizzle-orm/pg-core";
import { getTableName } from "drizzle-orm/table";
import {
  Cause,
  Chunk,
  Deferred,
  Duration,
  Effect,
  Fiber,
  Logger,
  Queue,
  Schedule,
  Stream,
} from "effect";
import { createEVM, type EVM } from "evm";
import { AbiParameters, type Hex, TypedData } from "ox";
import {
  type AsyncSlotGetter,
  createStorageProxy,
  encodeStorageState,
  type StorageLayout,
  type StorageProxy,
} from "storage-layout";
import {
  ContractFunctionRevertedError,
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  extractChain,
  http,
  keccak256,
  RawContractError,
} from "viem";
import { sendRawTransactionSync } from "viem/actions";
import * as chains from "viem/chains";
import type {
  BundleView,
  FFCAConfig,
  FFCADatabase,
  FFCAMutationConfig,
} from "./config";
import { buildEip712Types, hashMutationEip712 } from "./eip712";
import { encodeBundleArg, executeAbi } from "./encoding";
import {
  deploymentLockKey,
  deploymentSchemaName,
  migrate,
  updateSchema,
} from "./migrate";
import type {
  AnchoredBundle,
  BlockEvent,
  BundleEvent,
  MutationEvent,
  ResolvedMutation,
  SubmittedMutation,
  SubmittedMutationEvent,
} from "./types";
import { layerWatchLive, Watch } from "./watch";

// TODO sequencing: name-list works (config.sequence). Next is a state-aware
//   callback (state, mutations) => ordered for fee-priority / fairness rules.
// TODO decoded projection: revm is the acceptance gate; JS `apply` now projects
//   accepted EVM transitions into decoded app state. Longer term, replace this
//   app-authored projection with storage diff decoding.
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

type DeploymentLock = {
  connection: Bun.ReservedSQL;
  key: bigint;
};

type UnfinalizedBlock = Exclude<BlockEvent, { status: "accepted" }>;

export type FFCA<L extends StorageLayout = never> = {
  readonly state: unknown;
  readonly storage: [L] extends [never]
    ? unknown
    : StorageProxy<L, AsyncSlotGetter>;
  readonly domain: TypedData.Domain;
  execute(submitted: SubmittedMutation): Promise<MutationEvent>;
  on(event: "mutation", cb: MutationListener): () => void;
  on(event: "bundle", cb: BundleListener): () => void;
  on(event: "block", cb: BlockListener): () => void;
  stop(): Promise<void>;
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

function applyMutation(
  config: FFCAMutationConfig,
  args: unknown,
  state: unknown,
  resolution: unknown,
  signature: unknown,
  digest: Hex.Hex,
): void {
  if ("resolve" in config) {
    config.apply({ state, args, resolution, signature, digest });
  } else {
    config.apply({ state, args, signature, digest });
  }
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

function hasAllPersistenceHooks(mutation: FFCAMutationConfig): boolean {
  return (
    mutation.persistMutation !== undefined &&
    mutation.persistState !== undefined &&
    mutation.persistLifecycle !== undefined
  );
}

function hasAnyPersistenceHook(mutation: FFCAMutationConfig): boolean {
  return (
    mutation.persistMutation !== undefined ||
    mutation.persistState !== undefined ||
    mutation.persistLifecycle !== undefined
  );
}

function blockDepth(value: number | undefined, fallback: number, name: string) {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a safe non-negative integer`);
  }
  return value;
}

function collectPersistenceSchema(config: FFCAConfig): Record<string, PgTable> {
  const schema: Record<string, PgTable> = { ...(config.state.schema ?? {}) };
  for (const mutation of Object.values(config.mutations)) {
    schema[getTableName(mutation.table)] = mutation.table;
  }
  return schema;
}

function createPersistenceSchema(
  config: FFCAConfig,
): Record<string, PgTable> | undefined {
  const mutations = Object.values(config.mutations);
  const hasDatabase = config.database !== undefined;
  const hasStateSchema = config.state.schema !== undefined;
  const hasStateLoad = config.state.load !== undefined;
  const hasAnyHooks = mutations.some(hasAnyPersistenceHook);
  const hasAllHooks = mutations.every(hasAllPersistenceHooks);
  const persistenceEnabled =
    hasDatabase && hasStateSchema && hasStateLoad && hasAllHooks;
  const persistenceDisabled =
    !hasDatabase && !hasStateSchema && !hasStateLoad && !hasAnyHooks;

  if (persistenceDisabled) {
    return undefined;
  }
  if (!persistenceEnabled) {
    throw new Error(
      "FFCA persistence must be fully configured: database, state.schema, state.load, and all mutation persistence hooks are required together",
    );
  }
  const database = config.database;
  if (database === undefined) {
    throw new Error("FFCA persistence database is required");
  }

  const schemaName = deploymentSchemaName(config.chainId, config.address);
  return updateSchema(collectPersistenceSchema(config), schemaName);
}

async function acquireDeploymentLock(
  config: FFCAConfig,
): Promise<DeploymentLock | undefined> {
  if (config.database === undefined) return undefined;

  const connection = await config.database.connection.reserve();
  const key = deploymentLockKey(config.chainId, config.address);
  try {
    const [{ locked = false } = { locked: false }] = await connection<
      { locked: boolean }[]
    >`SELECT pg_try_advisory_lock(${key}) AS locked`;
    if (locked === false) {
      throw new Error(
        `FFCA deployment is already locked: chainId=${config.chainId} address=${config.address}`,
      );
    }
    return { connection, key };
  } catch (error) {
    connection.release();
    throw error;
  }
}

async function releaseDeploymentLock(lock: DeploymentLock): Promise<void> {
  try {
    await lock.connection`SELECT pg_advisory_unlock(${lock.key})`;
  } finally {
    lock.connection.release();
  }
}

async function startPersistence(
  config: FFCAConfig,
  schema: Record<string, PgTable> | undefined,
): Promise<{ db: FFCADatabase; lock: DeploymentLock } | undefined> {
  if (schema === undefined) return undefined;

  const lock = await acquireDeploymentLock(config);
  try {
    if (lock === undefined) {
      throw new Error("FFCA deployment lock is required");
    }
    if (config.database === undefined) {
      throw new Error("FFCA persistence database is required");
    }
    const db = drizzle(config.database.connection, {
      schema,
      casing: "snake_case",
    }) as FFCADatabase;
    await migrate(db, config.chainId, config.address);
    return { db, lock };
  } catch (error) {
    if (lock !== undefined) {
      await releaseDeploymentLock(lock);
    }
    throw error;
  }
}

async function loadNextIds(
  db: FFCADatabase,
  config: FFCAConfig,
): Promise<{ mutationId: number; bundleId: number }> {
  let maxMutationId = -1;
  let maxBundleId = -1;
  for (const mutation of Object.values(config.mutations)) {
    // biome-ignore lint/suspicious/noExplicitAny: mutation tables share ffca's id column by convention
    const table = mutation.table as any;
    const [row] = await db
      .select({
        maxMutationId: sql<number>`coalesce(max(${table.id}), -1)`,
        maxBundleId: sql<number>`coalesce(max(${table.bundleId}), -1)`,
      })
      .from(mutation.table);
    if (row !== undefined && row.maxMutationId > maxMutationId) {
      maxMutationId = row.maxMutationId;
    }
    if (row !== undefined && row.maxBundleId > maxBundleId) {
      maxBundleId = row.maxBundleId;
    }
  }
  return { mutationId: maxMutationId + 1, bundleId: maxBundleId + 1 };
}

export async function createFFCA<const C extends FFCAConfig>(
  config: C,
): Promise<FFCA<C["storageLayout"]>> {
  // Mutable so failure-isolation can swap the binding back to a snapshot
  // when a mutation's apply throws mid-mutation. Exposed via getter below.
  let state = config.state.initial;

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

  const rpcUrls = Array.isArray(config.rpcUrl)
    ? config.rpcUrl
    : [config.rpcUrl];
  // viem's `extractChain` is typed with a literal-union of known chain ids;
  // we accept any number at the framework boundary and cast through.
  const chain = extractChain({
    chains: Object.values(chains),
    id: config.chainId as 1,
  });
  const transport = http(rpcUrls[0], { retryCount: 0 });
  const publicClient = createPublicClient({ chain, transport });
  const walletClient = createWalletClient({
    account: config.account,
    chain,
    transport,
  });

  const persistenceSchema = createPersistenceSchema(config);
  let db: FFCADatabase | undefined;
  let deploymentLock: DeploymentLock | undefined;
  let mutationId = 0;
  let bundleId = 0;

  const persistence = await startPersistence(config, persistenceSchema);
  db = persistence?.db;
  deploymentLock = persistence?.lock;
  if (db !== undefined && config.state.load !== undefined) {
    try {
      state = await db.transaction((tx) => config.state.load!(tx));
      ({ mutationId, bundleId } = await loadNextIds(db, config));
    } catch (error) {
      if (deploymentLock !== undefined) {
        await releaseDeploymentLock(deploymentLock);
        deploymentLock = undefined;
      }
      throw error;
    }
  }

  // revm sidecar client. Always spawned: `runtimeEffect` calls `createEVM`
  // and `init` (with bytecode pulled from chain via `eth_getCode`) before
  // entering the parallel programs, so the bundle/submit loops can
  // dereference this unconditionally. Torn down via the runtime's Effect
  // scope on `stop()`. See `PLAN_revm.md` for the integration plan.
  let evm!: EVM;
  const storage = createStorageProxy(config.storageLayout, async (slots) => {
    if (evm === undefined) {
      throw new Error("ffca storage read before revm initialized");
    }
    return Effect.runPromise(
      evm.readStorage({ address: config.address, slots }),
    );
  });
  const initialRevmStorage = encodeStorageState(
    config.storageLayout,
    state as never,
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

  const mutationQueue = Effect.runSync(Queue.unbounded<QueuedMutation>());
  const submitQueue = Effect.runSync(Queue.unbounded<BundleEvent>());
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

  // Accept a set of queued mutations as one offchain bundle, then hand it to
  // submit. FIFO calls this with one mutation immediately; bundle mode calls
  // it with a sorted interval batch.
  const acceptBundle = (queued: QueuedMutation[], position: number) =>
    Effect.gen(function* () {
      if (queued.length === 0) return;

      const accepted: Extract<MutationEvent, { status: "accepted" }>[] = [];
      const rejections: { item: (typeof queued)[number]; error: unknown }[] =
        [];

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

      // revm is the primary acceptance gate. `resolve` computes any extra
      // calldata, revm executes the mutation against the local EVM state, and JS
      // `apply` projects successful EVM state transitions into the decoded
      // read-model state.
      for (const item of queued) {
        const {
          config: mutationConfig,
          args,
          signature,
          digest,
        } = item.submitted;
        try {
          const resolution = yield* Effect.tryPromise({
            try: () =>
              resolveMutation(
                mutationConfig,
                args,
                signature,
                storage,
                bundleView,
              ),
            catch: (error) => error as Error,
          });
          verifyResolution(mutationConfig, resolution, item.submitted.name);
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
          const mutationCalldata = encodeFunctionData({
            abi: executeAbi(config.signature.params),
            functionName: "execute",
            args: [
              [encodeBundleArg([acceptedMutation], config.signature.params)],
              [],
            ],
          });
          const result = yield* evm.execute({
            from: config.account.address,
            to: config.address,
            data: mutationCalldata,
          });
          if (result.success === false) {
            throw createRevmRevertError(config, result.revert_data);
          }

          applyMutation(
            mutationConfig,
            args,
            state,
            resolution,
            signature,
            digest,
          );

          accepted.push(acceptedMutation);
        } catch (error) {
          rejections.push({ item, error });
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

      yield* Effect.tryPromise({
        try: async () => {
          if (db === undefined) return;
          await db.transaction(async (tx) => {
            for (const [
              mutationIndex,
              mutation,
            ] of bundleEvent.mutations.entries()) {
              await mutation.config.persistMutation!(tx, {
                mutation,
                bundle: { id: bundleEvent.id, mutationIndex },
              });
              await mutation.config.persistState!(tx, {
                mutation,
              });
            }
          });
        },
        catch: (error) => error as Error,
      });

      for (const a of accepted) {
        emitMutation(a);
        const item = queued.find((q) => q.submitted.id === a.id)!;
        yield* Deferred.succeed(item.deferred, a);
      }

      emitBundle(bundleEvent);
      emitBlock({ status: "accepted", bundles: [bundleEvent] });
      yield* Queue.offer(submitQueue, bundleEvent);
    });

  const sequencedBundle = Effect.gen(function* () {
    const queued = Chunk.toArray(yield* Queue.takeAll(mutationQueue));
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
  // TODO error policy: today an RPC failure that survives retry crashes the
  //   submit fiber (Effect.orDie below). The bundle's mutation Deferreds have
  //   already been resolved as "accepted", so callers don't see this. Real
  //   fix is per-bundle status updates + event fan-out.
  const submit = Effect.gen(function* () {
    bundlePosition = 0;
    const accepted = Chunk.toArray(yield* Queue.takeAll(submitQueue));
    if (accepted.length === 0) return;

    // submitQueue only holds AcceptedBundle today; narrow for the rest of
    // the body.
    const bundles = accepted as Extract<BundleEvent, { status: "accepted" }>[];

    const rpcRetry = Effect.retry({
      times: 8,
      schedule: Schedule.spaced(Duration.millis(200)),
    });

    const args = bundles.map((b) =>
      encodeBundleArg(b.mutations, config.signature.params),
    );
    const forceExecuteIndexes: bigint[] = [];
    const calldata = encodeFunctionData({
      abi: config.abi,
      functionName: "execute",
      args: [args, forceExecuteIndexes],
    });

    yield* Effect.tryPromise({
      try: () =>
        publicClient.simulateContract({
          account: config.account.address,
          abi: config.abi,
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

    // The chain has accepted these bundles; commit every open revm journal
    // (one per bundle picked up from the queue this submit pass) so revm's
    // canonical state advances in lockstep. Pre-broadcast failures left no
    // journal to commit because the bundle loop reverts on all-reject; a
    // partial-batch broadcast failure crashes via `rpcRetry` orDie before
    // reaching here.
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

    yield* Effect.tryPromise({
      try: async () => {
        if (db === undefined) return;
        await db.transaction(async (tx) => {
          for (const bundle of anchored) {
            for (const mutation of bundle.mutations) {
              await mutation.config.persistLifecycle!(tx, {
                lifecycle: "included",
                mutation: mutation as Extract<
                  ResolvedMutation,
                  { status: "included" }
                >,
                block: {
                  number: block.number,
                  hash: block.hash,
                  timestamp: block.timestamp,
                  transactionHash,
                },
                calldata,
              });
            }
          }
        });
      },
      catch: (error) => error as Error,
    });

    for (const b of anchored) {
      emitBundle(b);
      for (const m of b.mutations) emitMutation(m);
    }
    emitBlock(includedBlock);
    unfinalizedBlocks.push(includedBlock);
  });

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

            yield* Effect.tryPromise({
              try: async () => {
                if (db === undefined) return;
                await db.transaction(async (tx) => {
                  for (const bundle of blockEvent.bundles) {
                    for (const mutation of bundle.mutations) {
                      switch (nextStatus) {
                        case "safe":
                          await mutation.config.persistLifecycle!(tx, {
                            lifecycle: "safe",
                            mutation: mutation as Extract<
                              ResolvedMutation,
                              { status: "safe" }
                            >,
                          });
                          break;
                        case "finalized":
                          await mutation.config.persistLifecycle!(tx, {
                            lifecycle: "finalized",
                            mutation: mutation as Extract<
                              ResolvedMutation,
                              { status: "finalized" }
                            >,
                          });
                          break;
                      }
                    }
                  }
                });
              },
              catch: (error) => error as Error,
            });

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
  ).pipe(Effect.orDie);

  const sequencedBundleProgram = Effect.repeat(
    sequencedBundle,
    Schedule.fixed(Duration.millis(sequencing.bundleIntervalMs)),
  ).pipe(Effect.orDie);

  const bundleProgram =
    sequencing.order === "fifo" ? fifoBundleProgram : sequencedBundleProgram;

  const submitProgram = Effect.repeat(
    submit,
    Schedule.fixed(Duration.millis(sequencing.submitIntervalMs)),
  ).pipe(Effect.orDie);

  const watchProgram = watch.pipe(
    Effect.provide(
      layerWatchLive({
        chainId: config.chainId,
        rpcUrl: config.rpcUrl,
        pollIntervalMs: sequencing.blockPollingIntervalMs,
        maxChainDepth: confirmations.finalizedBlockDepth,
      }),
    ),
    Effect.orDie,
  );

  let runtimeReady = false;
  const {
    promise: runtimeReadyPromise,
    resolve: resolveRuntimeReady,
    reject: rejectRuntimeReady,
  } = Promise.withResolvers<void>();

  const runtimeEffect = Effect.gen(function* () {
    // Spawn the sidecar inside the runtime's scope so its lifetime is bound
    // to the runtime fiber. `Effect.scoped` below closes the scope (and
    // shuts down the subprocess) when the fiber finishes or is interrupted
    // by `stop()`. Init runs sequentially before `Effect.all`, so the
    // bundle/submit closures see the assigned binding by the time they run.
    //
    // Pull `config.address`'s deployed bytecode from chain and seed revm with
    // decoded app state encoded through `config.storageLayout`. Dependency
    // contracts (ERC-20s, registries, …) aren't pulled yet.
    //
    // Missing code (config.address points at an empty account) is tolerated:
    // ffca logs a warning and inits revm with chain context only. The shadow
    // executes still run; they no-op against an empty address. Production
    // misconfiguration surfaces here as a startup log line plus a near-
    // immediate submit failure when the broadcast tries to call into a
    // contract that doesn't exist.
    evm = yield* createEVM();
    const code = yield* Effect.tryPromise({
      try: () => publicClient.getCode({ address: config.address }),
      catch: (error) => error as Error,
    });
    if (code === undefined || code === "0x") {
      yield* Effect.logWarning(
        `no contract code at config.address=${config.address}; ` +
          "revm code load skipped — runtime will continue but revm has no contract bytecode",
      );
      yield* evm.init({
        chain_id: config.chainId,
        accounts: { [config.address]: { storage: initialRevmStorage } },
      });
    } else {
      yield* evm.init({
        chain_id: config.chainId,
        accounts: {
          [config.address]: {
            code,
            storage: initialRevmStorage,
          },
        },
      });
    }
    yield* Effect.sync(() => {
      runtimeReady = true;
      resolveRuntimeReady();
    });
    yield* Effect.logInfo("ffca runtime started");
    yield* Effect.all([bundleProgram, submitProgram, watchProgram], {
      concurrency: "unbounded",
    });
  }).pipe(Effect.scoped, Effect.provide(Logger.json));

  const fiber = Effect.runFork(runtimeEffect);
  Effect.runPromiseExit(Fiber.join(fiber)).then((exit) => {
    if (exit._tag === "Failure") {
      const cause = Cause.pretty(exit.cause);
      if (!runtimeReady) rejectRuntimeReady(new Error(cause));
      if (!Cause.isInterruptedOnly(exit.cause)) {
        console.error("FATAL: ffca runtime fiber died", cause);
      }
    }
  });

  function execute(submitted: SubmittedMutation): Promise<MutationEvent> {
    return Effect.runPromise(
      Effect.gen(function* () {
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
      }).pipe(Effect.provide(Logger.json)),
    );
  }

  function stop(): Promise<void> {
    return Effect.runPromise(
      Effect.gen(function* () {
        yield* Queue.shutdown(mutationQueue);
        yield* Queue.shutdown(submitQueue);
        yield* Fiber.interrupt(fiber);
        if (deploymentLock !== undefined) {
          yield* Effect.tryPromise({
            try: () => releaseDeploymentLock(deploymentLock!),
            catch: (error) => error as Error,
          });
          deploymentLock = undefined;
        }
      }).pipe(Effect.provide(Logger.json)),
    );
  }

  function on(event: "mutation", cb: MutationListener): () => void;
  function on(event: "bundle", cb: BundleListener): () => void;
  function on(event: "block", cb: BlockListener): () => void;
  function on(
    event: "mutation" | "bundle" | "block",
    cb: MutationListener | BundleListener | BlockListener,
  ): () => void {
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
  }

  try {
    await runtimeReadyPromise;
  } catch (error) {
    await stop().catch(() => {});
    throw error;
  }

  return {
    get state() {
      return state;
    },
    storage: storage as unknown as FFCA<C["storageLayout"]>["storage"],
    domain,
    execute,
    on,
    stop,
  };
}
