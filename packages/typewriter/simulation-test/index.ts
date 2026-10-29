import { BunRuntime, BunServices } from "@effect/platform-bun";
import { SQL } from "bun";
import {
  Cause,
  Clock,
  Deferred,
  Duration,
  Effect,
  Exit,
  Fiber,
  FiberSet,
  Layer,
  Logger,
  Option,
  Random,
  Scope,
} from "effect";
import { Hex } from "ox";
import { privateKeyToAccount } from "viem/accounts";
import { KeyType } from "../src/client";
import type { TypewriterManifest } from "../src/config";
import { Database, makeDb } from "../src/db";
import { encodeEnqueueCalldata } from "../src/encoding";
import { logger, loggerLayer } from "../src/logger";
import { layerRpc } from "../src/rpc";
import {
  createSolidityTypewriterApp,
  loadSolidityMetadata,
} from "../src/sol-parse";
import { createTypewriterEffect, type ProgramError } from "../src/typewriter";
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
import { makeSimScheduler } from "./scheduler";
import { makeSimDb } from "./sim-db";
import { makeSimTransport } from "./sim-rpc";
import { validate } from "./validate";

export type SIM = {
  seed: string;
  /** The run fails when the runtime emits no mutation event for this much virtual time. */
  stallTimeoutMs: number;
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
            Effect.logInfo("Dropped simulation database").pipe(
              Effect.annotateLogs({ database: name }),
            ),
          ),
        )
      : Effect.logInfo("Kept simulation database").pipe(
          Effect.annotateLogs({
            database: name,
            seed: SIM.seed,
            psql: `psql ${url}`,
            drop: `DROP DATABASE "${name}" WITH (FORCE)`,
          }),
        ),
);

const program = Effect.gen(function* () {
  yield* Effect.logInfo("Started simulation").pipe(
    Effect.annotateLogs({ seed: SIM.seed, config: SIM }),
  );
  const chain = yield* makeChain();
  const address = yield* deploy({ chain, deployer: SCHEDULER.address });
  const chainId = Number(yield* chain.request({ method: "eth_chainId" }));
  yield* Effect.logInfo("Deployed simulation contract").pipe(
    Effect.annotateLogs({ address, chain_id: chainId }),
  );
  const database = yield* makeDatabase;
  yield* Effect.logInfo("Created simulation database").pipe(
    Effect.annotateLogs({ database: database.name }),
  );
  const metadata = yield* Effect.promise(() =>
    loadSolidityMetadata(ASSESSMENT_ENTRYPOINT),
  );
  const app = createSolidityTypewriterApp(
    {
      address,
      account: SCHEDULER,
      chainId,
      // Anvil's chain has no Monad hardfork schedule.
      hardfork: "MonadTen",
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
    },
    metadata,
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
  // Every mutation ends finalized or rejected, once, and every resubmission
  // ends rejected.
  let settlements = 0;
  const mutations = signers.length + plan.length;
  const resubmissions = plan.filter((step) => step.resubmit).length;
  // The virtual time of the last mutation event.
  let progressedAt = startMs;

  // The world's scope outlives its fiber, so `validate` can read the runtime's
  // views after the run. The runtime's fibers run on the simulated scheduler,
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

    const typewriter = yield* createTypewriterEffect<
      AssessmentStorage,
      AssessmentMutations,
      "fifo" | "batch"
    >(app);

    const drained = yield* Deferred.make<void>();
    yield* typewriter.on("mutation", (event) => {
      mutationEvents.push(event);
      progressedAt = clock.currentTimeMillisUnsafe();
      if (event.status !== "finalized" && event.status !== "rejected") return;
      settlements++;
      if (settlements === mutations + resubmissions) {
        Deferred.doneUnsafe(drained, Effect.void);
      }
    });
    yield* typewriter.on("batch", (event) => {
      batchEvents.push(event);
    });
    yield* typewriter.on("block", (event) => {
      blockEvents.push(event);
    });

    yield* FiberSet.run(fibers, typewriter.program);
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
        yield* Effect.logInfo("Reorged simulation chain").pipe(
          Effect.annotateLogs({ depth: replaced, timestamp }),
        );
      }).pipe(Effect.forever),
    );

    /** Executes the mutation of `step` and checks the result is one of `want`. */
    const submit = (step: Step, what: string, want: string[]) =>
      Effect.gen(function* () {
        const { mutation } = step;
        const exit = yield* Effect.exit(typewriter.execute(mutation));
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
        // The first submission runs here, not on the scheduler, until it waits
        // on its result, so it is queued before the resubmission starts.
        const first = yield* Effect.forkChild(
          submit(
            step,
            "execute",
            unlessExpired(shouldRevert ? fail : "success"),
          ),
          { startImmediately: true },
        );
        if (step.resubmit) {
          yield* submit(
            step,
            "resubmit",
            unlessExpired(shouldRevert ? fail : "InvalidNonce"),
          );
        }
        const exit = yield* Fiber.join(first);
        if (Exit.isSuccess(exit)) {
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

    const client = Effect.gen(function* () {
      for (const signer of signers) {
        yield* typewriter
          .execute(createAccount(manifest, signer))
          .pipe(Effect.orDie);
      }

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

      yield* Deferred.await(drained);
      return typewriter;
    });

    return yield* Effect.raceFirst(
      client,
      FiberSet.join(fibers).pipe(Effect.andThen(Effect.never)),
    );
  }).pipe(
    Scope.provide(scope),
    Effect.provideService(Database, makeSimDb({ db, io: scheduler.io })),
    Effect.provide(layerRpc(transports)),
    Effect.provideService(Clock.Clock, clock),
    Effect.provide(
      Layer.effect(Random.Random, makeRandom(SIM.seed, "runtime")),
    ),
    // `TYPEWRITER_LOG_LEVEL` applies to the runtime only. The run's own logs
    // print at every level.
    Effect.provide(loggerLayer),
  );

  yield* Effect.logInfo("Started simulation world").pipe(
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
      return yield* Effect.die(
        `stalled for ${SIM.stallTimeoutMs}ms of virtual time`,
      );
    }
    clock.advanceTo(next);
  }
  const typewriter = yield* exit;
  yield* Effect.logInfo("Settled simulation mutations").pipe(
    Effect.annotateLogs({
      mutations,
      virtual_ms: Math.round(clock.currentTimeMillisUnsafe() - startMs),
      wall_ms: Math.round(performance.now() - wallStart),
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
  });

  yield* Effect.logInfo("Validated simulation run").pipe(
    Effect.annotateLogs({
      mutations,
      blocks: blockEvents.length,
      batches: batchEvents.length,
      reorgs,
      wall_ms: Math.round(performance.now() - wallStart),
    }),
  );
});

BunRuntime.runMain(
  program.pipe(
    Effect.tapCause((cause) => Effect.logError("Failed simulation", cause)),
    Effect.scoped,
    Effect.provide(Logger.layer([logger])),
    Effect.provide(BunServices.layer),
  ),
  { disableErrorReporting: true },
);
