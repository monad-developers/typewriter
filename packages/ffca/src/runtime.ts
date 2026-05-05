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
} from "effect";
import { TypedData } from "ox";
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
import type { BundleView, FFCAConfig, FFCAMutationConfig } from "./config";
import { buildEip712Types } from "./eip712";
import { encodeBundleArg } from "./encoding";
import type {
  AnchoredBundle,
  BlockEvent,
  BundleEvent,
  MutationEvent,
  PendingMutation,
  ResolvedMutation,
  SubmittedMutation,
} from "./types";

// TODO sequencing: name-list works (config.sequence). Next is a state-aware
//   callback (state, mutations) => ordered for fee-priority / fairness rules.
// TODO state cloning: today the order-book runtime structuredClones state per
//   bundle for failure isolation. Major perf pain point — needs a different
//   model (e.g. fallible-resolve / infallible-apply contract, or a journaled
//   apply that can undo).
// TODO account model + signature verification (verifyMutation stub below)
// TODO persistence: nothing wired here yet
// TODO event fan-out / SSE: skipped for the scaffold

const BUNDLE_INTERVAL_MS = 50;
const SUBMIT_INTERVAL_MS = 400;
const BLOCK_POLLING_INTERVAL_MS = 200;

type MutationListener = (event: MutationEvent) => void;
type BundleListener = (event: BundleEvent) => void;
type BlockListener = (event: BlockEvent) => void;

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
//   See apps/order-book-backend/src/signature.ts:135-260.
export function verifyMutation(
  mutation: FFCAMutationConfig,
  submitted: SubmittedMutation,
  domain: TypedData.Domain,
): void {
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
}

function applyMutation(
  pending: PendingMutation,
  state: unknown,
  bundle: BundleView,
): { resolution?: unknown } {
  const { config, args } = pending;
  if ("resolve" in config) {
    const resolution = config.resolve(state, args, bundle);
    // biome-ignore lint/suspicious/noExplicitAny: resolution shape user-defined
    (config.apply as any)(state, args, resolution);
    return { resolution };
  }

  config.apply(state, args);
  return {};
}

export function createFFCA(config: FFCAConfig): FFCA {
  const state = config.state.initial;

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

    // Snapshot the bundle's mutations for `resolve` to read. Built once;
    // doesn't reflect failures or mid-bundle state changes.
    const bundleView: BundleView = queued.map((q) => ({
      name: q.pending.name,
      args: q.pending.args,
    }));

    for (const item of queued) {
      // TODO state cloning / failure isolation. For now we trust apply not to
      //   throw. When apply does throw we currently corrupt state.
      try {
        const { resolution } = applyMutation(item.pending, state, bundleView);
        const event = {
          ...item.pending,
          status: "accepted" as const,
          resolution,
        };
        accepted.push(event);
        emitMutation(event);
        yield* Deferred.succeed(item.deferred, event);
      } catch (error) {
        const rejected: MutationEvent = {
          ...item.pending,
          status: "rejected",
          error,
        };
        emitMutation(rejected);
        yield* Deferred.fail(item.deferred, error);
      }
    }

    if (accepted.length === 0) return;

    // TODO persist bundle + mutations here
    const bundleEvent: BundleEvent = {
      id: bundleId++,
      status: "accepted",
      position,
      mutations: accepted,
    };

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

    const args = bundles.map((b) => encodeBundleArg(b.mutations));
    const calldata = encodeFunctionData({
      abi: config.abi,
      functionName: "execute",
      args: [args],
    });

    yield* Effect.tryPromise({
      try: () =>
        publicClient.simulateContract({
          account: config.account.address,
          abi: config.abi,
          address: config.address,
          functionName: "execute",
          args: [args],
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

    // Promote each bundle from accepted → proposed by constructing a fresh
    // AnchoredBundle (the union members have different shapes — can't mutate
    // in place and stay typed).
    const anchored = bundles.map((b): AnchoredBundle => {
      const proposedMutations = b.mutations.map(
        (m): Extract<ResolvedMutation, { status: "proposed" }> => ({
          ...m,
          status: "proposed",
        }),
      );
      return {
        id: b.id,
        status: "proposed",
        position: b.position,
        mutations: proposedMutations,
        number: block.number,
        hash: block.hash,
        transactionHash,
      };
    });

    yield* Effect.logInfo("bundles proposed").pipe(
      Effect.annotateLogs({
        bundleIds: bundles.map((b) => b.id),
        bundleCount: bundles.length,
        mutationCount: bundles.reduce((n, b) => n + b.mutations.length, 0),
        blockNumber: block.number.toString(),
        transactionHash,
      }),
    );

    for (const b of anchored) {
      emitBundle(b);
      for (const m of b.mutations) emitMutation(m);
    }
    emitBlock({
      status: "proposed",
      number: block.number,
      hash: block.hash,
      timestamp: block.timestamp,
      bundles: anchored,
    });
  });

  // watch: poll latest block, advance proposed bundles → voted/finalized/verified
  const watch = Effect.gen(function* () {
    // TODO poll publicClient.getBlock, advance status by confirmation depth,
    //   persist transitions, emit block events.
    //   See apps/order-book-backend/src/runtime.ts:1098-1176.
  });

  const bundleProgram = Effect.repeat(
    bundle,
    Schedule.fixed(Duration.millis(BUNDLE_INTERVAL_MS)),
  ).pipe(Effect.orDie);

  const submitProgram = Effect.repeat(
    submit,
    Schedule.fixed(Duration.millis(SUBMIT_INTERVAL_MS)),
  ).pipe(Effect.orDie);

  const watchProgram = Effect.repeat(
    watch,
    Schedule.spaced(Duration.millis(BLOCK_POLLING_INTERVAL_MS)),
  ).pipe(Effect.orDie);

  const runtimeEffect = Effect.gen(function* () {
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
        verifyMutation(mutation, submitted, domain);

        const pending: PendingMutation = {
          ...submitted,
          id: mutationId++,
          status: "pending",
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
