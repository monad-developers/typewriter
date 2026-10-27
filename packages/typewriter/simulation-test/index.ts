import { BunRuntime, BunServices } from "@effect/platform-bun";
import { SQL } from "bun";
import {
  Cause,
  Clock,
  Context,
  Deferred,
  Duration,
  Effect,
  Exit,
  Fiber,
  FiberSet,
  Layer,
  type LogLevel,
  Option,
  Random,
  Scheduler,
  Scope,
} from "effect";
import { Hex } from "ox";
import { privateKeyToAccount } from "viem/accounts";
import { KeyType } from "../src/client";
import type { TypewriterManifest } from "../src/config";
import { Database, makeDb } from "../src/db";
import { encodeEnqueueCalldata } from "../src/encoding";
import { loggerLayer } from "../src/logger";
import { layerRpc, type Rpc } from "../src/rpc";
import { loadSolidityTypewriterApp } from "../src/sol-parse";
import {
  type CreateTypewriterError,
  createTypewriterEffect,
  type ProgramError,
  type TypewriterEffect,
} from "../src/typewriter";
import type {
  BatchEvent,
  BlockEvent,
  MutationEvent,
} from "../src/typewriter-types";
import {
  createAccount,
  deploy,
  makePlan,
  makeSigner,
  mutationKey,
  type Step,
  signAtSubmission,
} from "./assessment";
import {
  ASSESSMENT_ENTRYPOINT,
  type AssessmentMutations,
  type AssessmentStorage,
} from "./assessment-constants";
import { type Chain, makeChain } from "./chain";
import { makeSimClock } from "./clock";
import { int, makeRandom, pick } from "./random";
import { makeSimScheduler, type SimGroup } from "./scheduler";
import { makeSimDb } from "./sim-db";
import { makeSimTransport } from "./sim-rpc";
import { validate } from "./validate";

export type SIM = {
  seed: string;
  /** The run fails when the runtime emits no mutation event for this much virtual time. */
  stallTimeoutMs: number;
  /** The run fails when a soft shutdown takes longer than this, in virtual time. */
  softShutdownTimeoutMs: number;
  /** How often the scheduler moves the clock to the next sleep before a pick, while tasks are ready. */
  jumpRate: number;
  /** How often the scheduler releases an in-flight I/O result before a pick, while tasks are ready. */
  ioRate: number;
  chain: {
    blockTimeMs: number;
    genesisTimestamp: number;
    /** How often a block is a reorg, which replaces up to `finalizedBlockDepth` blocks. */
    reorgRate: number;
  };
  generator: {
    /** The key type of each account. */
    accounts: KeyType[];
    mutations: number;
    /** The delays between submissions that a step draws from. */
    delaysMs: number[];
    revertRate: number;
    enqueueRate: number;
    /** How often an executed step is executed again as soon as it is received. */
    resubmitRate: number;
    /**
     * The seconds from a step's submission to its authorization's expiration
     * that a step draws from. `-1` expires before genesis, so it always fails,
     * `0` and the intermediate ones expire around the step's inclusion, and
     * `Infinity` never expires. `Infinity` repeats so most steps draw it.
     */
    expirationsS: number[];
    /**
     * The shutdowns of the runtime, in order. A soft shutdown closes the
     * runtime's scope. A hard one stops its fibers where they are, as a
     * crash of the process does. Then the runtime starts again on the same
     * database and chain.
     */
    shutdowns: {
      kind: "soft" | "hard";
      /** How long after the runtime starts. The first comes after the accounts exist. */
      afterMs: number;
      /** How long until the next runtime starts. The chain keeps mining. */
      downtimeMs: number;
    }[];
  };
  typewriter: {
    submitIntervalMs: number;
    blockPollingIntervalMs: number;
    finalizedBlockDepth: number;
    ordering:
      | { order: "fifo" }
      | {
          order: "batch";
          batchIntervalMs: number;
          batchOrder: ["A", "B"] | ["B", "A"];
        };
  };
  transports: {
    latencyMs: [number, number];
    errorRate: number;
    applyThenErrorRate: number;
  }[];
  db: {
    latencyMs: [number, number];
  };
};

/** The seed for every draw in a run. Set `SEED` to repeat a run. */
// biome-ignore lint/complexity/useLiteralKeys: `process.env` has an index signature.
const SEED = process.env["SEED"] || Hex.random(32);

// biome-ignore lint/complexity/useLiteralKeys: `process.env` has an index signature.
const DATABASE_URL = process.env["DATABASE_URL"];
if (DATABASE_URL === undefined || DATABASE_URL === "") {
  console.error(
    "usage: DATABASE_URL=<postgres url> bun simulation-test/index.ts",
  );
  process.exit(1);
}

/** The configuration of a run. Each value is drawn from `SEED` and its path. */
export const SIM: SIM = {
  seed: SEED,
  stallTimeoutMs: 300_000,
  softShutdownTimeoutMs: 10_000,
  jumpRate: pick(SEED, "jumpRate", [0, 0.0001, 0.001]),
  ioRate: pick(SEED, "ioRate", [0, 0.01, 0.1]),
  chain: {
    blockTimeMs: pick(SEED, "chain.blockTimeMs", [100, 300, 400, 1_000]),
    genesisTimestamp: 1_700_000_000,
    reorgRate: pick(SEED, "chain.reorgRate", [0, 0.01, 0.05, 0.2]),
  },
  generator: {
    accounts: Array.from(
      { length: int(SEED, "generator.accounts", 1, 6) },
      (_, i) =>
        pick(SEED, `generator.accounts.${i}`, [
          KeyType.Secp256k1,
          KeyType.P256,
          KeyType.WebAuthnP256,
        ]),
    ),
    mutations: int(SEED, "generator.mutations", 4, 1000),
    delaysMs: pick(SEED, "generator.delaysMs", [
      [0],
      [0, 1, 10],
      [0, 50, 500],
      [10, 100, 1_000],
    ]),
    revertRate: pick(SEED, "generator.revertRate", [0, 0.01, 0.05, 0.1]),
    enqueueRate: pick(SEED, "generator.enqueueRate", [0, 0.01, 0.05, 0.1]),
    resubmitRate: pick(SEED, "generator.resubmitRate", [0, 0.01, 0.1, 1]),
    expirationsS: [-1, 0, 1, 2, 5, ...Array<number>(20).fill(Infinity)],
    shutdowns: Array.from(
      { length: pick(SEED, "generator.shutdowns", [0, 1, 3, 5]) },
      (_, i) => ({
        kind: pick(SEED, `generator.shutdowns.${i}.kind`, ["soft", "hard"] as (
          | "soft"
          | "hard"
        )[]),
        afterMs: pick(
          SEED,
          `generator.shutdowns.${i}.afterMs`,
          [0, 10, 100, 1_000, 10_000, 60_000],
        ),
        downtimeMs: pick(
          SEED,
          `generator.shutdowns.${i}.downtimeMs`,
          [0, 100, 1_000, 10_000],
        ),
      }),
    ),
  },
  typewriter: {
    submitIntervalMs: pick(
      SEED,
      "typewriter.submitIntervalMs",
      [50, 300, 1_000],
    ),
    blockPollingIntervalMs: pick(
      SEED,
      "typewriter.blockPollingIntervalMs",
      [50, 200, 1_000],
    ),
    finalizedBlockDepth: int(SEED, "typewriter.finalizedBlockDepth", 1, 5),
    ordering:
      pick(SEED, "typewriter.ordering", ["fifo", "batch"]) === "fifo"
        ? { order: "fifo" }
        : {
            order: "batch",
            batchIntervalMs: pick(
              SEED,
              "typewriter.ordering.batchIntervalMs",
              [10, 50, 300],
            ),
            batchOrder: pick(SEED, "typewriter.ordering.batchOrder", [
              ["A", "B"],
              ["B", "A"],
            ] as (["A", "B"] | ["B", "A"])[]),
          },
  },
  transports: Array.from(
    { length: int(SEED, "transports.length", 1, 3) },
    (_, i) => ({
      latencyMs: pick(SEED, `transports.${i}.latencyMs`, [
        [1, 5],
        [5, 50],
        [50, 500],
      ] as [number, number][]),
      errorRate: pick(SEED, `transports.${i}.errorRate`, [0, 0.01, 0.1]),
      applyThenErrorRate: pick(
        SEED,
        `transports.${i}.applyThenErrorRate`,
        [0, 0.01, 0.1],
      ),
    }),
  ),
  db: {
    latencyMs: pick(SEED, "db.latencyMs", [
      [0, 1],
      [1, 10],
      [10, 100],
    ] as [number, number][]),
  },
};

/** The first Anvil account. */
const SCHEDULER = privateKeyToAccount(
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
);

/** Sends `enqueue` transactions. The second Anvil account, so its nonces never meet the runtime's. */
const CLIENT = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";

/**
 * The gas limit of an `enqueue` transaction, about three times what one uses.
 * Monad's storage gas depends on state that can change between the estimate
 * and the block, so an estimated limit can run out.
 */
const ENQUEUE_GAS = Hex.fromNumber(1_000_000);

/**
 * Logs a lifecycle event of the run. `None` is the one level that no minimum
 * level filters out, so these print at every `TYPEWRITER_LOG_LEVEL`.
 */
const logSim = Effect.logWithLevel("None" as LogLevel.Severity);

/**
 * A database of its own for the run. It is dropped when the run passes, and
 * kept for inspection when it fails or is interrupted.
 */
const makeDatabase = Effect.acquireRelease(
  Effect.promise(async () => {
    const name = `typewriter_sim_${process.pid}_${Date.now()}`;
    const admin = new SQL({ url: DATABASE_URL, max: 1 });
    await admin.unsafe(`CREATE DATABASE "${name}"`);
    // The run never survives a Postgres crash, so commits need not wait for
    // the WAL flush.
    await admin.unsafe(`ALTER DATABASE "${name}" SET synchronous_commit = off`);
    await admin.close();
    const url = new URL(DATABASE_URL);
    url.pathname = `/${name}`;
    return { name, url: url.toString() };
  }),
  ({ name, url }, exit) =>
    Exit.isSuccess(exit)
      ? Effect.promise(async () => {
          const admin = new SQL({ url: DATABASE_URL, max: 1 });
          await admin.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
          await admin.close();
        }).pipe(
          Effect.andThen(
            logSim("dropped database").pipe(
              Effect.annotateLogs({ database: name }),
            ),
          ),
        )
      : logSim("kept database").pipe(
          Effect.annotateLogs({
            database: name,
            seed: SIM.seed,
            psql: `psql ${url}`,
            drop: `DROP DATABASE "${name}" WITH (FORCE)`,
          }),
        ),
);

const program = Effect.gen(function* () {
  yield* logSim("starting simulation").pipe(
    Effect.annotateLogs({ seed: SIM.seed, config: SIM }),
  );
  const chain = yield* makeChain();
  const address = yield* deploy({ chain, deployer: SCHEDULER.address });
  const chainId = Number(yield* chain.request({ method: "eth_chainId" }));
  yield* logSim("deployed contract").pipe(
    Effect.annotateLogs({ address, chainId }),
  );
  const database = yield* makeDatabase;
  yield* logSim("created database").pipe(
    Effect.annotateLogs({ database: database.name }),
  );
  const app = yield* Effect.promise(() =>
    loadSolidityTypewriterApp(ASSESSMENT_ENTRYPOINT, {
      address,
      account: SCHEDULER,
      chainId,
      rpcUrl: SIM.transports.map((_, index) => `sim-${index}`) as [
        string,
        ...string[],
      ],
      database: { url: database.url },
      blockPollingIntervalMs: SIM.typewriter.blockPollingIntervalMs,
      confirmations: {
        finalizedBlockDepth: SIM.typewriter.finalizedBlockDepth,
      },
      sequencing: {
        ...SIM.typewriter.ordering,
        submitIntervalMs: SIM.typewriter.submitIntervalMs,
      },
    }),
  );
  const manifest = app.manifest as TypewriterManifest<AssessmentMutations>;
  // One connection runs the statements in the order `io` starts them, so
  // Postgres sees no race that depends on wall-clock time.
  const db = yield* makeDb({ url: database.url, maxConnections: 1 });

  const signers = SIM.generator.accounts.map((keyType, i) =>
    makeSigner(i, keyType),
  );
  const plan = makePlan(signers, yield* makeRandom(SIM.seed, "generator"));

  // The simulation: a seeded scheduler, and a clock that moves when no fiber
  // can run, or when the scheduler jumps it. Anvil and Postgres run outside
  // it, through `io`.
  const startMs = SIM.chain.genesisTimestamp * 1000;
  const scheduler = makeSimScheduler(
    yield* makeRandom(SIM.seed, "scheduler"),
    SIM.jumpRate,
    () => {
      const next = clock.nextWakeup();
      if (next !== undefined) clock.advanceTo(next);
    },
    SIM.ioRate,
  );
  const clock = makeSimClock(startMs, scheduler.schedule);
  const simChain: Chain = {
    request: (request) => scheduler.io(chain.request(request)),
    mine: (timestamp) => scheduler.io(chain.mine(timestamp)),
    reorg: (depth, timestamp) => scheduler.io(chain.reorg(depth, timestamp)),
  };
  const chainRandom = yield* makeRandom(SIM.seed, "chain");
  let reorgs = 0;
  const transports = SIM.transports.map((_, index) =>
    makeSimTransport({ chain: simChain, index }),
  ) as [
    ReturnType<typeof makeSimTransport>,
    ...ReturnType<typeof makeSimTransport>[],
  ];

  // What the runtime told the outside world, for `validate`.
  /** The `executionIndex` that `execute` returned, by mutation key. */
  const results = new Map<string, bigint>();
  const mutationEvents: MutationEvent<AssessmentMutations>[] = [];
  /** Emitted only with batch sequencing. */
  const batchEvents: BatchEvent<AssessmentMutations>[] = [];
  const blockEvents: BlockEvent<"fifo" | "batch", AssessmentMutations>[] = [];
  const mutations = signers.length + plan.length;
  /** Mutations that a runtime accepted, which every later runtime owes. */
  const accepted = new Set<string>();
  /** Mutations whose `execute` a shutdown cut off before a runtime accepted them. */
  const dropped = new Set<string>();
  /**
   * How many submissions of each mutation have not settled, finalized or
   * rejected, or been cut off. A resubmission ends rejected under the same
   * key as its first submission.
   */
  const outstanding = new Map<string, number>();
  const send = (key: string) => {
    outstanding.set(key, (outstanding.get(key) ?? 0) + 1);
  };
  let clientDone = false;
  let shutdownsDone = false;
  // The virtual time of the last mutation event, or of the last start.
  let progressedAt = startMs;

  // The world's scope outlives its fiber, so `validate` can read the runtime's
  // views after the run. The world's fibers run on the simulated scheduler,
  // so it runs their interruption.
  const scope = yield* Effect.acquireRelease(Scope.make(), (scope) =>
    Effect.promise(() => {
      Effect.runFork(Scope.close(scope, Exit.void), { scheduler });
      return scheduler.runUntilIdle();
    }),
  );
  const world = Effect.gen(function* () {
    // A failure of any fiber in the set fails the run.
    const fibers = yield* FiberSet.make<void, ProgramError>();
    /** A failure of a runtime, which fails the run. */
    const failed = yield* Deferred.make<
      never,
      CreateTypewriterError | ProgramError
    >();
    const drained = yield* Deferred.make<void>();
    const checkDrained = () => {
      if (clientDone && shutdownsDone && outstanding.size === 0) {
        Deferred.doneUnsafe(drained, Effect.void);
      }
    };

    // Each runtime runs in a group of its own, as a process of its own would,
    // so a hard shutdown can stop its fibers without stopping the world's.
    const context = yield* Effect.context<Database | Rpc>();
    const forkIn = <a, e>(
      group: SimGroup,
      effect: Effect.Effect<a, e, Database | Rpc>,
    ) =>
      Effect.runForkWith(Context.add(context, Scheduler.Scheduler, group))(
        effect,
      );

    type Typewriter = TypewriterEffect<
      AssessmentStorage,
      AssessmentMutations,
      "fifo" | "batch"
    >;
    type Runtime = {
      index: number;
      group: SimGroup;
      scope: Scope.Closeable;
      /** Starts the runtime, then runs its program. */
      fiber: Fiber.Fiber<never, CreateTypewriterError | ProgramError>;
      ready: Deferred.Deferred<Typewriter>;
      /** Done once the runtime has shut down. */
      down: Deferred.Deferred<void>;
    };
    /** Done with the runtime that accepts `execute` calls, until it shuts down. */
    let up = yield* Deferred.make<Runtime>();

    const start = (index: number) =>
      Effect.gen(function* () {
        const group = scheduler.group();
        const runtimeScope = yield* Scope.make();
        const ready = yield* Deferred.make<Typewriter>();
        const down = yield* Deferred.make<void>();
        const upNow = up;
        const runtime: Runtime = {
          index,
          group,
          scope: runtimeScope,
          ready,
          down,
          fiber: forkIn(
            group,
            Effect.gen(function* () {
              const typewriter = yield* createTypewriterEffect<
                AssessmentStorage,
                AssessmentMutations,
                "fifo" | "batch"
              >(app).pipe(Scope.provide(runtimeScope));

              yield* typewriter.on("mutation", (event) => {
                mutationEvents.push(event);
                progressedAt = clock.currentTimeMillisUnsafe();
                const key = mutationKey(event.authorization);
                if (event.status === "accepted") accepted.add(key);
                if (
                  event.status !== "finalized" &&
                  event.status !== "rejected"
                ) {
                  return;
                }
                settle(key);
              });
              yield* typewriter.on("batch", (event) => {
                batchEvents.push(event);
              });
              yield* typewriter.on("block", (event) => {
                blockEvents.push(event);
              });

              progressedAt = clock.currentTimeMillisUnsafe();
              yield* Deferred.succeed(ready, typewriter);
              yield* Deferred.succeed(upNow, runtime);
              return yield* typewriter.program;
            }),
          ),
        };
        runtime.fiber.addObserver((exit) => {
          // A soft shutdown interrupts the runtime. Any other exit fails the run.
          if (Exit.isFailure(exit) && !Cause.hasInterruptsOnly(exit.cause)) {
            Deferred.doneUnsafe(failed, exit);
          }
        });
        return runtime;
      });

    /** Closes the runtime's scope, from inside its group, as its process would. */
    const softShutdown = (runtime: Runtime) =>
      Effect.gen(function* () {
        const closed = yield* Deferred.make<void>();
        forkIn(
          runtime.group,
          Effect.gen(function* () {
            yield* Fiber.interrupt(runtime.fiber);
            yield* Scope.close(runtime.scope, Exit.void);
            yield* Deferred.succeed(closed, undefined);
          }),
        );
        const done = yield* Deferred.await(closed).pipe(
          Effect.timeoutOption(Duration.millis(SIM.softShutdownTimeoutMs)),
        );
        if (Option.isNone(done)) {
          return yield* Effect.die(
            `soft shutdown of runtime ${runtime.index} hung for ${SIM.softShutdownTimeoutMs}ms`,
          );
        }
        if (scheduler.busy(runtime.group) || clock.sleeping(runtime.group)) {
          return yield* Effect.die(
            `soft shutdown of runtime ${runtime.index} left fibers running`,
          );
        }
      });

    /** Stops the runtime's fibers where they are. Its I/O in flight lands. */
    const hardShutdown = (runtime: Runtime) =>
      Effect.gen(function* () {
        clock.crash(runtime.group);
        yield* scheduler.crash(runtime.group);
      });

    const shutdowns = Effect.gen(function* () {
      let runtime = yield* start(0);
      yield* Deferred.await(accountsCreated);
      for (const [i, shutdown] of SIM.generator.shutdowns.entries()) {
        yield* Effect.sleep(Duration.millis(shutdown.afterMs));
        if (Deferred.isDoneUnsafe(up)) up = yield* Deferred.make<Runtime>();
        yield* logSim("shutting down runtime").pipe(
          Effect.annotateLogs({
            runtime: runtime.index,
            kind: shutdown.kind,
            ready: Deferred.isDoneUnsafe(runtime.ready),
          }),
        );
        yield* shutdown.kind === "soft"
          ? softShutdown(runtime)
          : hardShutdown(runtime);
        yield* Deferred.succeed(runtime.down, undefined);
        yield* Effect.sleep(Duration.millis(shutdown.downtimeMs));
        runtime = yield* start(i + 1);
        yield* logSim("started runtime").pipe(
          Effect.annotateLogs({ runtime: runtime.index }),
        );
      }
      shutdownsDone = true;
      checkDrained();
      return runtime;
    });

    yield* FiberSet.run(
      fibers,
      Effect.gen(function* () {
        yield* Effect.sleep(Duration.millis(SIM.chain.blockTimeMs));
        // Anvil takes whole seconds, so blocks in the same second share a timestamp.
        const timestamp = Math.floor((yield* Clock.currentTimeMillis) / 1000);
        if (chainRandom.nextDoubleUnsafe() >= SIM.chain.reorgRate) {
          yield* simChain.mine(timestamp);
          return;
        }
        // A reorg of at most `finalizedBlockDepth` replaces no finalized block.
        const depth =
          1 +
          Math.floor(
            chainRandom.nextDoubleUnsafe() * SIM.typewriter.finalizedBlockDepth,
          );
        const replaced = yield* simChain.reorg(depth, timestamp);
        if (replaced === 0) return;
        reorgs++;
        yield* logSim("reorged chain").pipe(
          Effect.annotateLogs({ depth: replaced, timestamp }),
        );
      }).pipe(Effect.forever),
    );

    /**
     * Calls `execute` of `runtime`, from inside its group, as a request to its
     * process would. `undefined` when a shutdown cuts it off.
     */
    const call = (
      runtime: Runtime,
      typewriter: Typewriter,
      mutation: Step["mutation"] | ReturnType<typeof createAccount>,
    ) =>
      Effect.gen(function* () {
        const result =
          yield* Deferred.make<
            Exit.Exit<
              Effect.Success<ReturnType<Typewriter["execute"]>>,
              Effect.Error<ReturnType<Typewriter["execute"]>>
            >
          >();
        forkIn(
          runtime.group,
          Effect.exit(typewriter.execute(mutation)).pipe(
            Effect.flatMap((exit) => Deferred.succeed(result, exit)),
          ),
        );
        const exit = yield* Deferred.await(result).pipe(
          Effect.raceFirst(
            Deferred.await(runtime.down).pipe(Effect.as(undefined)),
          ),
        );
        // A soft shutdown fails a waiting `execute`, which is a cut-off too.
        if (
          exit === undefined ||
          (Exit.isFailure(exit) &&
            Option.getOrUndefined(Cause.findErrorOption(exit.cause))?._tag ===
              "TypewriterStoppedError")
        ) {
          return undefined;
        }
        return exit;
      });

    /** The runtime that is up, once it is. */
    const runtimeUp = Effect.gen(function* () {
      const runtime = yield* Deferred.await(up);
      return { runtime, typewriter: yield* Deferred.await(runtime.ready) };
    });

    /** Records that a submission of `key` settled, or a shutdown cut it off. */
    const settle = (key: string) => {
      const count = (outstanding.get(key) ?? 0) - 1;
      if (count > 0) outstanding.set(key, count);
      else outstanding.delete(key);
      checkDrained();
    };

    /**
     * Records that a shutdown cut off a submission of `key`. A runtime still
     * owes a mutation it accepted.
     */
    const cutOff = (key: string, resubmission: boolean) => {
      // TODO(kyle) shutdowns: decide what a runtime owes a mutation it had
      // received but not accepted. For now it is dropped, never resent.
      if (!resubmission && accepted.has(key)) return;
      if (!resubmission) dropped.add(key);
      settle(key);
    };

    /**
     * Executes the mutation of `step` on `runtime` and checks the result is
     * one of `want`. `undefined` when a shutdown cuts it off.
     */
    const submit = (
      { runtime, typewriter }: Effect.Success<typeof runtimeUp>,
      step: Step,
      what: "execute" | "resubmit",
      want: string[],
    ) =>
      Effect.gen(function* () {
        const { mutation } = step;
        const key = mutationKey(mutation.authorization);
        send(key);
        const exit = yield* call(runtime, typewriter, mutation);
        if (exit === undefined) {
          cutOff(key, what === "resubmit");
          return undefined;
        }
        const error = Exit.isFailure(exit)
          ? Option.getOrUndefined(Cause.findErrorOption(exit.cause))
          : undefined;
        const got = Exit.isSuccess(exit)
          ? "success"
          : error?._tag === "MutationRevertedError" &&
              error.errorName !== undefined
            ? error.errorName
            : Cause.pretty(exit.cause);
        if (!want.includes(got)) {
          return yield* Effect.die(
            `step ${step.index} (${what} ${mutation.name}): got ${got}, want ${want.join(" or ")}`,
          );
        }
        return exit;
      });

    /**
     * Executes `step` and checks the result against `shouldRevert` and
     * `expiresInS`. A resubmission is a second, concurrent `execute` of the
     * same mutation. It fails: on the nonce the first one used, or on the same
     * revert. An expired authorization fails both before either check, and a
     * finite one may expire before either submission is simulated.
     */
    const execute = (step: Step) =>
      Effect.gen(function* () {
        const { mutation, expiresInS } = step;
        const fail = `${mutation.name}Error`;
        const shouldRevert = mutation.params.shouldRevert;
        const unlessExpired = (want: string) =>
          expiresInS < 0
            ? ["AuthorizationExpired"]
            : Number.isFinite(expiresInS)
              ? [want, "AuthorizationExpired"]
              : [want];
        // Both submissions go to the same runtime, so the resubmission cannot
        // reach a later runtime first.
        const up = yield* runtimeUp;
        // The first submission runs here, not on the scheduler, until it waits
        // on its result, so it is queued before the resubmission starts.
        const first = yield* Effect.forkChild(
          submit(
            up,
            step,
            "execute",
            unlessExpired(shouldRevert ? fail : "success"),
          ),
          { startImmediately: true },
        );
        if (step.resubmit) {
          yield* submit(
            up,
            step,
            "resubmit",
            unlessExpired(shouldRevert ? fail : "InvalidNonce"),
          );
        }
        const exit = yield* Fiber.join(first);
        if (exit !== undefined && Exit.isSuccess(exit)) {
          results.set(
            mutationKey(mutation.authorization),
            exit.value.executionIndex,
          );
        }
      });

    /**
     * Sends the `enqueue` of `step` from the client. Returns an effect that
     * checks it lands.
     */
    const enqueue = (step: Step) =>
      Effect.gen(function* () {
        const { mutation } = step;
        const data = encodeEnqueueCalldata({
          config: app.mutations[mutation.name]!,
          params: mutation.params,
          authorization: mutation.authorization,
        });
        send(mutationKey(mutation.authorization));
        const hash = yield* simChain.request({
          method: "eth_sendTransaction",
          params: [{ from: CLIENT, to: app.address, data, gas: ENQUEUE_GAS }],
        });
        return Effect.gen(function* () {
          while (true) {
            const receipt = yield* simChain.request({
              method: "eth_getTransactionReceipt",
              params: [hash],
            });
            if (receipt?.status === "0x1") return;
            if (receipt !== null) {
              return yield* Effect.die(
                `step ${step.index} (enqueue ${mutation.name}): transaction ${hash} reverted`,
              );
            }
            yield* Effect.sleep(Duration.millis(SIM.chain.blockTimeMs));
          }
        });
      });

    /** Done once every account exists, before the first shutdown. */
    const accountsCreated = yield* Deferred.make<void>();

    const client = Effect.gen(function* () {
      for (const signer of signers) {
        const mutation = createAccount(manifest, signer);
        send(mutationKey(mutation.authorization));
        const { runtime, typewriter } = yield* runtimeUp;
        const exit = yield* call(runtime, typewriter, mutation);
        if (exit === undefined || Exit.isFailure(exit)) {
          return yield* Effect.die(
            `create account ${signer.accountID}: ${exit === undefined ? "cut off" : Cause.pretty(exit.cause)}`,
          );
        }
      }
      yield* Deferred.succeed(accountsCreated, undefined);

      // Each step comes from its own client, so a step does not wait for the
      // one before it to settle.
      for (const step of plan) {
        yield* Effect.sleep(Duration.millis(step.delayMs));
        step.mutation = signAtSubmission(
          manifest,
          step,
          yield* Clock.currentTimeMillis,
        );
        yield* FiberSet.run(
          fibers,
          step.via === "execute" ? execute(step) : yield* enqueue(step),
        );
      }
      clientDone = true;
      checkDrained();
    });

    const run = Effect.gen(function* () {
      const [, runtime] = yield* Effect.all([client, shutdowns], {
        concurrency: 2,
      });
      yield* Deferred.await(drained);
      return yield* Deferred.await(runtime.ready);
    });

    return yield* run.pipe(
      Effect.raceFirst(
        FiberSet.join(fibers).pipe(Effect.andThen(Effect.never)),
      ),
      Effect.raceFirst(Deferred.await(failed)),
    );
  }).pipe(
    Scope.provide(scope),
    Effect.provideService(Database, makeSimDb({ db, io: scheduler.io })),
    Effect.provide(layerRpc(transports)),
    Effect.provideService(Clock.Clock, clock),
    Effect.provide(
      Layer.effect(Random.Random, makeRandom(SIM.seed, "runtime")),
    ),
  );

  yield* logSim("running world").pipe(
    Effect.annotateLogs({
      accounts: signers.length,
      steps: plan.length,
      transports: transports.length,
    }),
  );

  // The step loop: run every fiber that can run, then move the clock to the
  // next sleep.
  const wallStart = performance.now();
  let exit:
    | Exit.Exit<Effect.Success<typeof world>, Effect.Error<typeof world>>
    | undefined;
  const fiber = Effect.runFork(world, { scheduler });
  fiber.addObserver((result) => {
    exit = result;
  });
  while (exit === undefined) {
    yield* Effect.promise(() => scheduler.runUntilIdle());
    if (exit !== undefined) break;
    const next = clock.nextWakeup();
    if (next === undefined) {
      return yield* Effect.die(
        "deadlock: no fiber can run and no sleep is pending",
      );
    }
    if (next - progressedAt > SIM.stallTimeoutMs) {
      const unsettled = [...outstanding.keys()].slice(0, 10).map((key) => {
        const step = plan.find(
          (step) => mutationKey(step.mutation.authorization) === key,
        );
        const statuses = mutationEvents
          .filter((event) => mutationKey(event.authorization) === key)
          .map((event) => event.status);
        return `${step === undefined ? key : `step ${step.index} (${step.via})`}: ${statuses.join(" ") || "no events"}`;
      });
      return yield* Effect.die(
        `stalled for ${SIM.stallTimeoutMs}ms of virtual time, with ${outstanding.size} mutations outstanding:\n${unsettled.join("\n")}`,
      );
    }
    clock.advanceTo(next);
  }
  const typewriter = yield* exit;
  yield* logSim("settled mutations").pipe(
    Effect.annotateLogs({
      mutations,
      virtualMs: clock.currentTimeMillisUnsafe() - startMs,
      wallMs: Math.round(performance.now() - wallStart),
    }),
  );

  yield* validate({
    app,
    chain,
    db,
    signers,
    plan,
    results,
    mutationEvents,
    batchEvents,
    blockEvents,
    typewriter,
    ordering: SIM.typewriter.ordering,
    shutdowns: SIM.generator.shutdowns.length,
    dropped,
  });

  yield* logSim("validated run").pipe(
    Effect.annotateLogs({
      mutations,
      shutdowns: SIM.generator.shutdowns.length,
      dropped: dropped.size,
      blocks: blockEvents.length,
      batches: batchEvents.length,
      reorgs,
      wallMs: Math.round(performance.now() - wallStart),
    }),
  );
});

BunRuntime.runMain(
  program.pipe(
    Effect.scoped,
    Effect.annotateLogs({ category: "sim" }),
    Effect.provide(loggerLayer),
    Effect.provide(BunServices.layer),
  ),
);
