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
import { logger, loggerLayer } from "../src/logger";
import { layerRpc } from "../src/rpc";
import {
  createSolidityTypewriterApp,
  loadSolidityMetadata,
} from "../src/sol-parse";
import {
  createTypewriterEffect,
  type ExecuteError,
  type ProgramError,
} from "../src/typewriter";
import { EXPIRATION_MARGIN } from "../src/typewriter-constants";
import {
  createAccount,
  deploy,
  expect,
  makePlan,
  makeSigner,
  stepLabel,
  withExpiration,
} from "./assessment";
import {
  ASSESSMENT_ENTRYPOINT,
  type AssessmentMutations,
  type AssessmentStorage,
} from "./assessment-constants";
import { type Chain, makeChain } from "./chain";
import { makeSimClock } from "./clock";
import { prepare } from "./malformations";
import { int, makeRandom, pick } from "./random";
import {
  errorName,
  makeRun,
  mutationKey,
  type Result,
  type Run,
  type Submission,
} from "./run";
import { makeSimScheduler } from "./scheduler";
import { makeSimDb } from "./sim-db";
import { makeSimTransport } from "./sim-rpc";
import { validate } from "./validate";

export type SIM = {
  seed: string;
  /** The run fails when the runtime emits no mutation event for this much virtual time. */
  stallTimeoutMs: number;
  /** How often the scheduler jumps the clock before a pick, while tasks are ready. */
  jumpRate: number;
  /**
   * How far past now a jump moves the clock, at least to the next sleep, that
   * a jump draws from. A jump past `EXPIRATION_MARGIN` moves the next block's
   * timestamp past expirations the runtime accepted against the block before.
   */
  jumpsMs: number[];
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
     * that a step draws from. `-1` expires before genesis, so it always fails.
     * The runtime rejects one within `EXPIRATION_MARGIN` of the latest block,
     * so `0` and `EXPIRATION_MARGIN - 2` are rejected unless the runtime's
     * latest block is behind the clock, and `EXPIRATION_MARGIN` and above are
     * accepted, and expire if the clock jumps before their settlement.
     * `Infinity` never expires, and repeats so most steps draw it.
     */
    expirationsS: number[];
    /** How often a step submits a malformed mutation. See `malformations.ts`. */
    malformedRate: number;
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
  // The long jump passes the latest finite expiration, `EXPIRATION_MARGIN + 2`.
  jumpsMs: [0, 0, 0, (EXPIRATION_MARGIN + 3) * 1_000],
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
    expirationsS: [
      -1,
      0,
      EXPIRATION_MARGIN - 2,
      EXPIRATION_MARGIN,
      EXPIRATION_MARGIN + 2,
      ...Array<number>(20).fill(Infinity),
    ],
    malformedRate: pick(SEED, "generator.malformedRate", [0, 0.01, 0.05, 0.2]),
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
  /** Signers of each key type with no account, for malformed signatures. */
  const strangers = new Map(
    [KeyType.Secp256k1, KeyType.P256, KeyType.WebAuthnP256].map((keyType) => [
      keyType,
      makeSigner(-1, keyType),
    ]),
  );

  // The simulation: a seeded scheduler, and a clock that moves when no fiber
  // can run, or when the scheduler jumps it. Anvil and Postgres run outside
  // it, through `io`.
  const startMs = SIM.chain.genesisTimestamp * 1000;
  const jumpRandom = yield* makeRandom(SIM.seed, "jumps");
  const scheduler = makeSimScheduler(
    yield* makeRandom(SIM.seed, "scheduler"),
    SIM.jumpRate,
    () => {
      const now = clock.currentTimeMillisUnsafe();
      const jumpMs =
        SIM.jumpsMs[
          Math.floor(jumpRandom.nextDoubleUnsafe() * SIM.jumpsMs.length)
        ]!;
      const at = Math.max(clock.nextWakeup() ?? now, now + jumpMs);
      if (at > now) clock.advanceTo(at);
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
  const transports = SIM.transports.map((_, index) =>
    makeSimTransport({ chain: simChain, index }),
  ) as [
    ReturnType<typeof makeSimTransport>,
    ...ReturnType<typeof makeSimTransport>[],
  ];

  // What the run recorded, for `validate`.
  const run = makeRun();
  // Every mutation with events ends finalized or rejected once, and so does
  // every resubmission. The run drains when all of them have.
  const settlementsWanted =
    signers.length +
    plan.reduce(
      (sum, step) => sum + (expect(step).events ? (step.resubmit ? 2 : 1) : 0),
      0,
    );
  let settlements = 0;
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
    // Reads of the chain after an expiry, which the drain waits for.
    const expiryChecks = yield* FiberSet.make<void>();
    const runExpiryCheck = yield* FiberSet.runtime(expiryChecks)<never>();

    const typewriter = yield* createTypewriterEffect<
      AssessmentStorage,
      AssessmentMutations,
      "fifo" | "batch"
    >(app);

    /**
     * Records the chain's latest block right after the runtime rejected a
     * mutation as expired. The authorization must have expired by then, or
     * expire within `margin` seconds of it.
     */
    const checkExpiry = (key: string, expiration: bigint, margin: bigint) =>
      Effect.gen(function* () {
        const latest = yield* simChain.request({
          method: "eth_getBlockByNumber",
          params: ["latest", false],
        });
        run.expiryChecks.push({
          key,
          expiration,
          margin,
          latestTimestamp: BigInt(latest!.timestamp),
        });
      });

    const drained = yield* Deferred.make<void>();
    yield* typewriter.on("mutation", (event) => {
      run.mutationEvents.push(event);
      progressedAt = clock.currentTimeMillisUnsafe();
      const margin =
        event.status !== "rejected"
          ? undefined
          : errorName(event.error) === "AuthorizationExpired"
            ? 0n
            : errorName(event.error) === "MutationExpiresTooSoonError"
              ? BigInt(EXPIRATION_MARGIN)
              : undefined;
      if (margin !== undefined) {
        runExpiryCheck(
          checkExpiry(
            mutationKey(event.authorization),
            event.authorization.expiration,
            margin,
          ),
        );
      }
      if (event.status !== "finalized" && event.status !== "rejected") return;
      settlements++;
      if (settlements === settlementsWanted) {
        Deferred.doneUnsafe(drained, Effect.void);
      }
    });
    yield* typewriter.on("batch", (event) => {
      run.batchEvents.push(event);
    });
    yield* typewriter.on("block", (event) => {
      run.blockEvents.push(event);
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
        if (replaced.length === 0) return;
        run.reorgs.push({ replaced, timestamp });
        yield* Effect.logInfo("Reorged simulation chain").pipe(
          Effect.annotateLogs({ depth: replaced.length, timestamp }),
        );
      }).pipe(Effect.forever),
    );

    /**
     * Starts `execute` of `input`. It runs here, not on the scheduler, until
     * it first waits, so the runtime sees calls in submission order.
     */
    const startExecute = (input: unknown) =>
      Effect.forkChild(
        // Any shape, malformed or not.
        Effect.exit(typewriter.execute(input as never)),
        { startImmediately: true },
      );

    /**
     * Executes `input`, and again at once if `submission` is resubmitted, and
     * records what each returned.
     */
    const execute = (submission: Submission, input: unknown) =>
      Effect.gen(function* () {
        const first = yield* startExecute(input);
        const second = submission.resubmitted
          ? yield* startExecute(input)
          : undefined;
        submission.results[0] = resultOf(yield* Fiber.join(first));
        if (second !== undefined) {
          submission.results[1] = resultOf(yield* Fiber.join(second));
        }
      });

    /** Sends `calldata` to `enqueue` from the client. Returns the transaction. */
    const enqueue = (calldata: Hex.Hex) =>
      simChain.request({
        method: "eth_sendTransaction",
        params: [
          { from: CLIENT, to: app.address, data: calldata, gas: ENQUEUE_GAS },
        ],
      });

    /** Waits for the `enqueue` of `submission` to land. It never reverts. */
    const awaitEnqueue = ({ label, transactionHash }: Submission) =>
      Effect.gen(function* () {
        while (true) {
          const receipt = yield* simChain.request({
            method: "eth_getTransactionReceipt",
            params: [transactionHash!],
          });
          if (receipt?.status === "0x1") return;
          if (receipt !== null) {
            return yield* Effect.die(
              `${label}: enqueue ${transactionHash} reverted`,
            );
          }
          yield* Effect.sleep(Duration.millis(SIM.chain.blockTimeMs));
        }
      });

    const client = Effect.gen(function* () {
      for (const [index, signer] of signers.entries()) {
        const mutation = createAccount(manifest, signer);
        const submission: Submission = {
          label: `CreateAccount ${index}`,
          key: mutationKey(mutation.authorization),
          via: "execute",
          mutation,
          sent: deepFreeze(mutation),
          expected: {
            executes: true,
            errors: [],
            resubmissionErrors: [],
            events: true,
          },
          resubmitted: false,
          results: [],
          transactionHash: undefined,
        };
        run.submissions.push(submission);
        yield* execute(submission, submission.sent);
        const [result] = submission.results;
        if (result !== undefined && "error" in result) {
          return yield* Effect.die(`${submission.label}: got ${result.error}`);
        }
      }

      // Each step comes from its own client, so a step does not wait for the
      // one before it to settle.
      for (const step of plan) {
        yield* Effect.sleep(Duration.millis(step.delayMs));
        const prepared = prepare(step, {
          manifest,
          signer: step.signer,
          stranger: strangers.get(step.signer.keyType)!,
          mutation: withExpiration(step, yield* Clock.currentTimeMillis),
          random: yield* makeRandom(SIM.seed, `step:${step.index}`),
        });
        const { sent } = prepared;
        const submission: Submission = {
          label: stepLabel(step),
          key: prepared.key,
          via: step.via,
          mutation: prepared.mutation,
          sent: deepFreeze(sent.via === "execute" ? sent.input : sent.calldata),
          expected: expect(step),
          resubmitted: step.resubmit,
          results: [],
          transactionHash: undefined,
        };
        run.submissions.push(submission);
        if (sent.via === "execute") {
          yield* FiberSet.run(fibers, execute(submission, submission.sent));
        } else {
          submission.transactionHash = yield* enqueue(sent.calldata);
          yield* FiberSet.run(fibers, awaitEnqueue(submission));
        }
      }

      yield* Deferred.await(drained);
      yield* FiberSet.awaitEmpty(expiryChecks);
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
        `stalled for ${SIM.stallTimeoutMs}ms of virtual time, waiting on: ${unsettled(run).join(", ")}`,
      );
    }
    clock.advanceTo(next);
  }
  const typewriter = yield* exit;
  yield* Effect.logInfo("Settled simulation mutations").pipe(
    Effect.annotateLogs({
      submissions: run.submissions.length,
      virtual_ms: Math.round(clock.currentTimeMillisUnsafe() - startMs),
      wall_ms: Math.round(performance.now() - wallStart),
    }),
  );

  yield* validate({
    app,
    chain,
    db,
    run,
    typewriter,
    ordering: SIM.typewriter.ordering,
  });

  // Mutations accepted, then dropped when their settlement reverted in revm.
  const accepted = new Set<string>();
  let dropped = 0;
  for (const event of run.mutationEvents) {
    const key = mutationKey(event.authorization);
    if (event.status === "accepted") accepted.add(key);
    if (
      event.status === "rejected" &&
      accepted.has(key) &&
      errorName(event.error) === "AuthorizationExpired"
    ) {
      dropped++;
    }
  }

  yield* Effect.logInfo("Validated simulation run").pipe(
    Effect.annotateLogs({
      submissions: run.submissions.length,
      dropped,
      blocks: run.blockEvents.length,
      batches: run.batchEvents.length,
      reorgs: run.reorgs.length,
      wall_ms: Math.round(performance.now() - wallStart),
    }),
  );
});

/** What `execute` returned, as the run records it. */
function resultOf(
  exit: Exit.Exit<{ executionIndex: bigint }, ExecuteError>,
): Result {
  if (Exit.isSuccess(exit))
    return { executionIndex: exit.value.executionIndex };
  const error = Option.getOrUndefined(Cause.findErrorOption(exit.cause));
  return {
    error: error === undefined ? Cause.pretty(exit.cause) : errorName(error),
  };
}

/** Freezes `value` and everything it holds, so the runtime cannot change what the client sent. */
function deepFreeze<value>(value: value): value {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const entry of Object.values(value)) deepFreeze(entry);
  }
  return value;
}

/** The submissions the run still waits on for a final event. */
function unsettled(run: Run): string[] {
  const settled = new Map<string, number>();
  for (const event of run.mutationEvents) {
    if (event.status !== "finalized" && event.status !== "rejected") continue;
    const key = mutationKey(event.authorization);
    settled.set(key, (settled.get(key) ?? 0) + 1);
  }
  return run.submissions
    .filter(
      ({ key, expected, resubmitted }) =>
        expected.events && (settled.get(key) ?? 0) < (resubmitted ? 2 : 1),
    )
    .map(({ label }) => label);
}

BunRuntime.runMain(
  program.pipe(
    Effect.tapCause((cause) => Effect.logError("Failed simulation", cause)),
    Effect.scoped,
    Effect.provide(Logger.layer([logger])),
    Effect.provide(BunServices.layer),
  ),
  { disableErrorReporting: true },
);
