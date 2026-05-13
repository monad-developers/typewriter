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
import { AbiParameters, type Hex, TypedData } from "ox";
import {
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  extractChain,
  http,
  keccak256,
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
import { encodeBundleArg } from "./encoding";
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
  PendingMutation,
  ResolvedMutation,
  SubmittedMutation,
} from "./types";
import { layerWatchLive, Watch } from "./watch";

// TODO sequencing: name-list works (config.sequence). Next is a state-aware
//   callback (state, mutations) => ordered for fee-priority / fairness rules.
// TODO state cloning: today we structuredClone the bundle's state up front and
//   apply against the clone, reverting to a fresh snapshot on apply throws.
//   Same pattern the order-book runtime uses. revm subsumes this once it lands
//   (free state revert), so the perf hit is temporary.
// TODO signature validation: decide whether execute() should verify signatures
//   before queue admission or leave validation to app-owned resolve/apply logic.
// TODO runtime failure policy: submit/watch failures still die the fiber; define
//   bundle status updates and retry/dead-letter behavior.
// TODO HTTP / SSE shaping: event fan-out exists in-process; network surfaces are
//   still app-owned.

const BUNDLE_INTERVAL_MS = 50;
const SUBMIT_INTERVAL_MS = 400;
const BLOCK_POLLING_INTERVAL_MS = 200;
const VOTED_CONFIRMATIONS = 1n;
const FINALIZED_CONFIRMATIONS = 2n;
const VERIFIED_CONFIRMATIONS = 5n;

type MutationListener = (event: MutationEvent) => void;
type BundleListener = (event: BundleEvent) => void;
type BlockListener = (event: BlockEvent) => void;

type DeploymentLock = {
  connection: Bun.ReservedSQL;
  key: bigint;
};

type UnfinalizedBlock = Exclude<BlockEvent, { status: "accepted" }>;

export type FFCA = {
  readonly state: unknown;
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

function resolveMutation(
  config: FFCAMutationConfig,
  args: unknown,
  signature: unknown,
  state: unknown,
  bundle: BundleView,
): unknown {
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
  const hasAnyHooks = mutations.some(hasAnyPersistenceHook);
  const hasAllHooks = mutations.every(hasAllPersistenceHooks);
  const persistenceEnabled = hasDatabase && hasStateSchema && hasAllHooks;
  const persistenceDisabled = !hasDatabase && !hasStateSchema && !hasAnyHooks;

  if (persistenceDisabled) {
    return undefined;
  }
  if (!persistenceEnabled) {
    throw new Error(
      "FFCA persistence must be fully configured: database, state.schema, and all mutation persistence hooks are required together",
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

export function createFFCA(config: FFCAConfig): FFCA {
  // Mutable so failure-isolation can swap the binding back to a snapshot
  // when a mutation's apply throws mid-mutation. Exposed via getter below.
  let state = config.state.initial;

  const domain: TypedData.Domain = {
    name: config.domain.name,
    version: config.domain.version,
    chainId: config.chainId,
    verifyingContract: config.address,
  };

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

  const mutationQueue = Effect.runSync(
    Queue.unbounded<{
      pending: PendingMutation;
      deferred: Deferred.Deferred<MutationEvent, unknown>;
    }>(),
  );
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

  let mutationId = 0;
  let bundleId = 0;
  let bundlePosition = 0;

  // bundle: drain the mutation queue, apply each, hand off to submit
  const bundle = Effect.gen(function* () {
    const position = bundlePosition++;
    const queued = Chunk.toArray(yield* Queue.takeAll(mutationQueue));
    if (queued.length === 0) return;

    // Stable sort by config.sequence (FIFO if unset). Names not in sequence
    // are rejected at execute() time, so .indexOf returning -1 shouldn't
    // happen here.
    if (config.sequence) {
      const order = config.sequence;
      queued.sort(
        (a, b) => order.indexOf(a.pending.name) - order.indexOf(b.pending.name),
      );
    }

    const accepted: Extract<MutationEvent, { status: "accepted" }>[] = [];
    const rejections: { item: (typeof queued)[number]; error: unknown }[] = [];

    // Snapshot the bundle's mutations for `resolve` to read. Built once;
    // doesn't reflect failures or mid-bundle state changes.
    const bundleView: BundleView = queued.map((q) => ({
      name: q.pending.name,
      args: q.pending.args,
    }));

    // Failure isolation. `resolve` is pure (reads state, returns the
    // resolution). `apply` mutates in place. Snapshot before each apply so
    // a partially-mutating throw can be rolled back to the pre-apply state.
    // TODO perf: structuredClone(state) per mutation is O(state). revm
    //   subsumes this with native revert; until then, the cost is paid.
    for (const item of queued) {
      const { config, args, signature, digest } = item.pending;
      const snapshot = structuredClone(state);
      try {
        const resolution = resolveMutation(
          config,
          args,
          signature,
          state,
          bundleView,
        );
        verifyResolution(config, resolution, item.pending.name);
        applyMutation(config, args, state, resolution, signature, digest);
        const acceptedMutation = {
          ...item.pending,
          status: "accepted" as const,
          resolution,
        };
        accepted.push(acceptedMutation);
      } catch (error) {
        state = snapshot;
        rejections.push({ item, error });
      }
    }

    for (const { item, error } of rejections) {
      const rejected: MutationEvent = {
        ...item.pending,
        status: "rejected",
        error,
      };
      emitMutation(rejected);
      yield* Deferred.fail(item.deferred, error);
    }

    if (accepted.length === 0) return;

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
      const item = queued.find((q) => q.pending.id === a.id)!;
      yield* Deferred.succeed(item.deferred, a);
    }

    emitBundle(bundleEvent);
    emitBlock({ status: "accepted", bundles: [bundleEvent] });
    yield* Queue.offer(submitQueue, bundleEvent);
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

    const block = yield* Effect.tryPromise({
      try: () => publicClient.getBlock({ blockHash: receipt.blockHash }),
      catch: (error) => error as Error,
    }).pipe(rpcRetry);

    for (const bundle of bundles) {
      for (const mutation of bundle.mutations) {
        (mutation as ResolvedMutation).status = "proposed";
      }
      const anchoredBundle = bundle as unknown as AnchoredBundle;
      anchoredBundle.status = "proposed";
      anchoredBundle.number = block.number;
      anchoredBundle.hash = block.hash;
      anchoredBundle.transactionHash = transactionHash;
    }
    const anchored = bundles as unknown as AnchoredBundle[];

    yield* Effect.logInfo("bundles proposed").pipe(
      Effect.annotateLogs({
        bundleIds: bundles.map((b) => b.id),
        bundleCount: bundles.length,
        mutationCount: bundles.reduce((n, b) => n + b.mutations.length, 0),
        blockNumber: block.number.toString(),
        transactionHash,
      }),
    );

    const proposedBlock: Exclude<BlockEvent, { status: "accepted" }> = {
      status: "proposed",
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
                lifecycle: "proposed",
                mutation: mutation as Extract<
                  ResolvedMutation,
                  { status: "proposed" }
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
    emitBlock(proposedBlock);
    unfinalizedBlocks.push(proposedBlock);
  });

  const watch = Effect.gen(function* () {
    const watchService = yield* Watch;
    yield* watchService.messages.pipe(
      Stream.runForEach((message) =>
        Effect.gen(function* () {
          if (message._tag === "Reorged") {
            return yield* Effect.fail(
              new Error(
                `chain reorg detected: commonAncestor=${message.commonAncestor?.hash ?? "none"}`,
              ),
            );
          }

          for (const blockEvent of unfinalizedBlocks.filter(
            (block) => block.number < message.block.number,
          )) {
            const confirmations = message.block.number - blockEvent.number;
            let nextStatus: "voted" | "finalized" | "verified" | undefined;

            if (
              confirmations >= VERIFIED_CONFIRMATIONS &&
              blockEvent.status !== "verified"
            ) {
              nextStatus = "verified";
            } else if (
              confirmations >= FINALIZED_CONFIRMATIONS &&
              blockEvent.status !== "finalized" &&
              blockEvent.status !== "verified"
            ) {
              nextStatus = "finalized";
            } else if (
              confirmations >= VOTED_CONFIRMATIONS &&
              blockEvent.status !== "voted" &&
              blockEvent.status !== "finalized" &&
              blockEvent.status !== "verified"
            ) {
              nextStatus = "voted";
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
                        case "voted":
                          await mutation.config.persistLifecycle!(tx, {
                            lifecycle: "voted",
                            mutation: mutation as Extract<
                              ResolvedMutation,
                              { status: "voted" }
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
                        case "verified":
                          await mutation.config.persistLifecycle!(tx, {
                            lifecycle: "verified",
                            mutation: mutation as Extract<
                              ResolvedMutation,
                              { status: "verified" }
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
            (block) => block.status !== "verified",
          );
        }),
      ),
    );
  }).pipe(Effect.withLogSpan("watch"));

  const bundleProgram = Effect.repeat(
    bundle,
    Schedule.fixed(Duration.millis(BUNDLE_INTERVAL_MS)),
  ).pipe(Effect.orDie);

  const submitProgram = Effect.repeat(
    submit,
    Schedule.fixed(Duration.millis(SUBMIT_INTERVAL_MS)),
  ).pipe(Effect.orDie);

  const watchProgram = watch.pipe(
    Effect.provide(
      layerWatchLive({
        chainId: config.chainId,
        rpcUrl: config.rpcUrl,
        pollIntervalMs: BLOCK_POLLING_INTERVAL_MS,
      }),
    ),
    Effect.orDie,
  );

  const runtimeEffect = Effect.gen(function* () {
    const persistence = yield* Effect.tryPromise({
      try: () => startPersistence(config, persistenceSchema),
      catch: (error) => error as Error,
    });
    db = persistence?.db;
    deploymentLock = persistence?.lock;
    yield* Effect.logInfo("ffca runtime started");
    yield* Effect.all([bundleProgram, submitProgram, watchProgram], {
      concurrency: "unbounded",
    });
  }).pipe(Effect.provide(Logger.json));

  const fiber = Effect.runFork(runtimeEffect);
  Effect.runPromiseExit(Fiber.join(fiber)).then((exit) => {
    if (exit._tag === "Failure" && !Cause.isInterruptedOnly(exit.cause)) {
      console.error("FATAL: ffca runtime fiber died", Cause.pretty(exit.cause));
    }
  });

  function execute(submitted: SubmittedMutation): Promise<MutationEvent> {
    return Effect.runPromise(
      Effect.gen(function* () {
        const mutation = config.mutations[submitted.name];
        if (mutation === undefined) {
          throw new Error(`unknown mutation: ${submitted.name}`);
        }
        if (config.sequence && !config.sequence.includes(submitted.name)) {
          throw new Error(`mutation not in sequence: ${submitted.name}`);
        }
        const digest = verifyMutation(
          mutation,
          config.signature.params,
          submitted,
          domain,
        );

        const pending: PendingMutation = {
          ...submitted,
          id: mutationId++,
          status: "pending",
          digest,
          config: mutation,
        };
        emitMutation(pending);
        const deferred = yield* Deferred.make<MutationEvent, unknown>();
        yield* Queue.offer(mutationQueue, { pending, deferred });
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

  return {
    get state() {
      return state;
    },
    domain,
    execute,
    on,
    stop,
  };
}
