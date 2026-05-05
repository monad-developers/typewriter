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
import type { FFCAConfig } from "./config";
import { buildEip712Types } from "./eip712";
import type { BundleEvent, MutationEvent, SubmittedMutation } from "./types";

// TODO sequencing: pluggable, for now FIFO over the queue
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

export type FFCA = {
  readonly state: unknown;
  readonly domain: TypedData.Domain;
  execute(submitted: SubmittedMutation): Promise<MutationEvent>;
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
  config: FFCAConfig,
  name: string,
  args: unknown,
  domain: TypedData.Domain,
): void {
  const mutation = config.mutations[name];
  if (!mutation) throw new Error(`unknown mutation: ${name}`);

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
  config: FFCAConfig,
  state: unknown,
  name: string,
  args: unknown,
): { resolution?: unknown } {
  const mutation = config.mutations[name];
  if (!mutation) throw new Error(`unknown mutation: ${name}`);

  if ("resolve" in mutation) {
    const resolution = mutation.resolve(state, args);
    // biome-ignore lint/suspicious/noExplicitAny: resolution shape user-defined
    (mutation.apply as any)(state, args, resolution);
    return { resolution };
  }

  mutation.apply(state, args);
  return {};
}

// TODO encodeBundle(config, mutations) — wraps the contract's execute() call.
//   The order-book version hardcodes the Bundle tuple shape; ffca needs to
//   derive it from the contract ABI. Add when submit calls it.
//   See apps/order-book-backend/src/runtime.ts:529-543.

export function createFFCA(config: FFCAConfig): FFCA {
  const state = config.state.initial;

  const domain: TypedData.Domain = {
    name: config.domain.name,
    version: config.domain.version,
    chainId: config.chainId,
    verifyingContract: config.address,
  };

  const mutationQueue = Effect.runSync(
    Queue.unbounded<{
      id: number;
      submitted: SubmittedMutation;
      deferred: Deferred.Deferred<MutationEvent, unknown>;
    }>(),
  );
  const submitQueue = Effect.runSync(Queue.unbounded<BundleEvent>());

  let nextId = 0;
  let bundlePosition = 0;

  // bundle: drain the mutation queue, apply each, hand off to submit
  const bundle = Effect.gen(function* () {
    const position = bundlePosition++;
    const queued = Chunk.toArray(yield* Queue.takeAll(mutationQueue));
    if (queued.length === 0) return;

    const accepted: Extract<MutationEvent, { status: "accepted" }>[] = [];

    for (const item of queued) {
      // TODO state cloning / failure isolation. For now we trust apply not to
      //   throw. When apply does throw we currently corrupt state.
      try {
        const { resolution } = applyMutation(
          config,
          state,
          item.submitted.name,
          item.submitted.args,
        );
        const event = {
          ...item.submitted,
          id: item.id,
          status: "accepted" as const,
          resolution,
        };
        accepted.push(event);
        yield* Deferred.succeed(item.deferred, event);
      } catch (error) {
        yield* Deferred.fail(item.deferred, error);
      }
    }

    if (accepted.length === 0) return;

    // TODO persist bundle + mutations here
    const bundleEvent: BundleEvent = {
      id: position, // TODO real bundle id from db
      status: "accepted",
      position,
      mutations: accepted,
    };

    yield* Queue.offer(submitQueue, bundleEvent);
  });

  // submit: drain bundle queue, build calldata, broadcast to chain
  const submit = Effect.gen(function* () {
    bundlePosition = 0;
    const bundles = Chunk.toArray(yield* Queue.takeAll(submitQueue));
    if (bundles.length === 0) return;

    // TODO for each bundle: encodeBundle(config, bundle.mutations) → calldata.
    //   Then simulate, access-list, estimate, sign, broadcast, race RPCs.
    //   See apps/order-book-backend/src/runtime.ts:936-1089.

    // TODO update bundle/mutation statuses to "proposed", emit block event,
    //   persist block + bundle-block link
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
        verifyMutation(config, submitted.name, submitted.args, domain);

        const id = nextId++;
        const deferred = yield* Deferred.make<MutationEvent, unknown>();
        yield* Queue.offer(mutationQueue, { id, submitted, deferred });
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

  return {
    get state() {
      return state;
    },
    domain,
    execute,
    stop,
  };
}
