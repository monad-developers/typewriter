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
import { Hash, Hex } from "ox";
import { decodeEventLog } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { KeyType } from "../src/client";
import { createTypewriterApp, type TypewriterManifest } from "../src/config";
import { Database, makeDbClient } from "../src/db";
import { makePostgresTransport } from "../src/db-transport";
import { logger, loggerLayer } from "../src/logger";
import { layerRpc } from "../src/rpc";
import { loadSolidityApp } from "../src/sol-build";
import { createTypewriterEffect } from "../src/typewriter";
import { EXPIRATION_MARGIN, TYPEWRITER_ABI } from "../src/typewriter-constants";
import type { ExecuteError, ProgramError } from "../src/typewriter-errors";
import {
  createAccount,
  deploy,
  enqueueCalldata,
  expect,
  type Mutation,
  makeSigner,
  makeSteps,
  sign,
  stepLabel,
  withExpiration,
} from "./assessment";
import {
  ASSESSMENT_ENTRYPOINT,
  type AssessmentMutations,
  type AssessmentStorage,
  STORAGE_LAYOUT,
} from "./assessment-constants";
import { type Chain, makeChain } from "./chain";
import { makeSimClock } from "./clock";
import { makePlan, type Plan } from "./plan";
import { Rng } from "./random";
import {
  deepFreeze,
  errorName,
  makeRun,
  mutationKey,
  type Result,
  type Run,
  type Submission,
} from "./run";
import { makeSimScheduler } from "./scheduler";
import { makeSimDbTransport } from "./sim-db";
import { makeSimTransport } from "./sim-rpc";
import { validate } from "./validate";

/**
 * Usage: `SEED=<seed> bun simulation-test/index.ts [--plan <file>] [--print-plan]`
 *
 * Without `--plan`, the plan is generated from the seed.
 */
const args = process.argv.slice(2);
const planFile = args.includes("--plan")
  ? args[args.indexOf("--plan") + 1]
  : undefined;
const { SEED } = process.env;

const plan: Plan =
  planFile === undefined
    ? makePlan(SEED || Hex.random(32))
    : await Bun.file(planFile).json();

if (args.includes("--print-plan")) console.log(JSON.stringify(plan, null, 2));

// biome-ignore lint/complexity/useLiteralKeys: `process.env` has an index signature.
const DATABASE_URL = process.env["DATABASE_URL"];
if (DATABASE_URL === undefined || DATABASE_URL === "") {
  console.error(
    "usage: DATABASE_URL=<postgres url> bun simulation-test/index.ts",
  );
  process.exit(1);
}

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
const makeDatabase = (seed: string) =>
  Effect.acquireRelease(
    Effect.promise(async () => {
      const name = `typewriter_sim_${process.pid}_${Date.now()}`;
      const admin = new SQL({ url: DATABASE_URL, max: 1 });
      await admin.unsafe(`CREATE DATABASE "${name}"`);
      // The run never survives a Postgres crash, so commits need not wait for
      // the WAL flush.
      await admin.unsafe(
        `ALTER DATABASE "${name}" SET synchronous_commit = off`,
      );
      await admin.close();
      const url = new URL(DATABASE_URL);
      url.pathname = `/${name}`;
      return { name, url: url.toString() };
    }),
    ({ name, url }, exit) =>
      Exit.isSuccess(exit)
        ? Effect.promise(async () => {
            const start = performance.now();
            const admin = new SQL({ url: DATABASE_URL, max: 1 });
            await admin.unsafe(
              `DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`,
            );
            await admin.close();
            return Math.round(performance.now() - start);
          }).pipe(
            Effect.flatMap((duration) =>
              Effect.logInfo("Dropped simulation database").pipe(
                Effect.annotateLogs({ database: name, duration }),
              ),
            ),
          )
        : Effect.logInfo("Kept simulation database").pipe(
            Effect.annotateLogs({
              database: name,
              seed,
              psql: `psql ${url}`,
              drop: `DROP DATABASE "${name}" WITH (FORCE)`,
            }),
          ),
  );

const simulate = Effect.fnUntraced(function* (plan: Plan) {
  const simStart = performance.now();
  yield* Effect.logInfo("Started simulation").pipe(
    Effect.annotateLogs({
      seed: plan.seed,
      config: plan,
      duration: Math.round(performance.now() - simStart),
    }),
  );
  const deployStart = performance.now();
  const chain = yield* makeChain(plan, new Rng(plan.seed, "reorgs"));
  const address = yield* deploy({ plan, chain, deployer: SCHEDULER.address });
  const chainId = Number(yield* chain.request({ method: "eth_chainId" }));
  yield* Effect.logInfo("Deployed simulation contract").pipe(
    Effect.annotateLogs({
      address,
      chain_id: chainId,
      duration: Math.round(performance.now() - deployStart),
    }),
  );
  const databaseStart = performance.now();
  const database = yield* makeDatabase(plan.seed);
  yield* Effect.logInfo("Created simulation database").pipe(
    Effect.annotateLogs({
      database: database.name,
      duration: Math.round(performance.now() - databaseStart),
    }),
  );
  const worldStart = performance.now();
  const solidityApp = yield* Effect.promise(() =>
    loadSolidityApp(ASSESSMENT_ENTRYPOINT),
  );
  const app = createTypewriterApp({
    ...solidityApp,
    config: {
      address,
      account: SCHEDULER,
      chainId,
      // Anvil's chain has no Monad hardfork schedule.
      hardfork: "MonadTen",
      rpcUrl: plan.transports.map((_, index) => `sim-${index}`) as [
        string,
        ...string[],
      ],
      database: { url: database.url },
      blockPollingIntervalMs: plan.typewriter.blockPollingIntervalMs,
      sequencing: plan.typewriter.ordering,
    },
  });
  const manifest = app.manifest as TypewriterManifest<AssessmentMutations>;
  // One connection runs the statements in the order `io` starts them, so
  // Postgres sees no race that depends on wall-clock time.
  const transport = yield* makePostgresTransport({
    url: database.url,
    maxConnections: 1,
  });
  const db = makeDbClient(transport);

  const signers = plan.generator.accounts.map((keyType, i) =>
    makeSigner(plan, `account:${i}`, KeyType[keyType]),
  );
  const steps = makeSteps(plan, signers, new Rng(plan.seed, "generator"));

  // The simulation: a seeded scheduler, and a clock that moves when no fiber
  // can run, or when the scheduler jumps it. Anvil and Postgres run outside
  // it, through `io`.
  const startMs = plan.chain.genesisTimestamp * 1000;
  const jumpRandom = new Rng(plan.seed, "jumps");
  // A pause is rare, so at most one per `PAUSE_SPACING_MS` of virtual time.
  const PAUSE_SPACING_MS = 600_000;
  let pausedAt = -Infinity;
  const scheduler = makeSimScheduler(
    new Rng(plan.seed, "scheduler"),
    plan.scheduler.jumpRate,
    () => {
      const now = clock.currentTimeMillisUnsafe();
      const jumpMs = jumpRandom.weighted(plan.scheduler.jumpsMs);
      if (jumpMs > 0 && now - pausedAt < PAUSE_SPACING_MS) return;
      const at = Math.max(clock.nextWakeup() ?? now, now + jumpMs);
      if (at <= now) return;
      // A jump is a pause, not time the runtime had to make progress in.
      if (jumpMs > 0) {
        pausedAt = now;
        progressedAt += at - now;
      }
      clock.advanceTo(at);
    },
    plan.scheduler.ioRate,
  );
  const clock = makeSimClock(startMs, scheduler.schedule);
  const simChain: Chain = {
    request: (request) => scheduler.io(chain.request(request)),
    read: (request, asOfMs) => scheduler.io(chain.read(request, asOfMs)),
    stateDiff: chain.stateDiff,
    clearedAt: (address, slot) => scheduler.io(chain.clearedAt(address, slot)),
    mine: (atMs) => scheduler.io(chain.mine(atMs)),
    reorg: (depth, added, atMs) =>
      scheduler.io(chain.reorg(depth, added, atMs)),
  };
  const chainRandom = new Rng(plan.seed, "chain");
  const transports = plan.transports.map((_, index) =>
    makeSimTransport({ plan, chain: simChain, index }),
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
    steps.reduce(
      (sum, step) =>
        sum + (step.via === "execute" ? (step.resubmit ? 2 : 1) : 0),
      0,
    );
  let settlements = 0;
  // The enqueues the run still waits on to land, or to execute.
  const pendingEnqueues = new Set<string>();
  // The virtual time of the last mutation event, or force-executed enqueue.
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
    const checkExpiry = (key: string, expiration: number, margin: number) =>
      Effect.gen(function* () {
        const latest = yield* simChain.request({
          method: "eth_getBlockByNumber",
          params: ["latest", false],
        });
        run.expiryChecks.push({
          key,
          expiration,
          margin,
          latestTimestamp: Number(latest!.timestamp),
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
            ? 0
            : errorName(event.error) === "MutationExpiresTooSoonError"
              ? EXPIRATION_MARGIN
              : undefined;
      if (margin !== undefined) {
        runExpiryCheck(
          checkExpiry(
            mutationKey(event.authorization),
            // The authorization's, or the credential's.
            event.status === "rejected" &&
              event.error._tag === "MutationExpiresTooSoonError"
              ? event.error.expiration
              : event.authorization.expiration,
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
    // A listener may change its event, so each must get its own copy.
    yield* typewriter.on("mutation", scribble);
    yield* typewriter.on("batch", scribble);
    yield* typewriter.on("block", scribble);

    yield* FiberSet.run(fibers, typewriter.program);
    yield* FiberSet.run(
      fibers,
      Effect.gen(function* () {
        yield* Effect.sleep(Duration.millis(plan.chain.blockTimeMs));
        const atMs = yield* Clock.currentTimeMillis;
        const timestamp = Math.floor(atMs / 1000);
        if (!chainRandom.bool(plan.chain.reorgRate)) {
          yield* simChain.mine(atMs);
          return;
        }
        // A reorg of at most `finalizedBlockDepth` replaces no finalized block.
        // The new chain can be shorter or longer than the one it replaces.
        const depth = chainRandom.int(1, plan.chain.finalizedBlockDepth);
        const added = chainRandom.int(1, plan.chain.finalizedBlockDepth + 1);
        const { replaced, dropped } = yield* simChain.reorg(depth, added, atMs);
        if (replaced.length === 0) return;
        run.reorgs.push({ replaced, timestamp });
        yield* Effect.logInfo("Reorged simulation chain").pipe(
          Effect.annotateLogs({
            depth: replaced.length,
            added,
            dropped,
            timestamp,
          }),
        );
      }).pipe(Effect.forever),
    );

    /**
     * Starts `execute` of `mutation`. It runs here, not on the scheduler,
     * until it first waits, so the runtime sees calls in submission order.
     */
    const startExecute = (mutation: Mutation) =>
      Effect.gen(function* () {
        // The client may reuse what it sent, so the runtime must copy it.
        const input = structuredClone(mutation);
        const fiber = yield* Effect.forkChild(
          Effect.exit(typewriter.execute(input as never)),
          { startImmediately: true },
        );
        scribble(input);
        return fiber;
      });

    /**
     * Executes `submission`, and again at once if it is resubmitted, and
     * records what each returned.
     */
    const execute = (submission: Submission) =>
      Effect.gen(function* () {
        const first = yield* startExecute(submission.mutation);
        const second = submission.resubmitted
          ? yield* startExecute(submission.mutation)
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

    /**
     * Waits for the `enqueue` of `submission` to land, which it always does,
     * and sends it again when a reorg drops it. Then, if it should execute,
     * waits for a settlement to force-execute it, or for its authorization to
     * expire first: the runtime gives an enqueue no events.
     */
    const awaitEnqueue = (submission: Submission, calldata: Hex.Hex) =>
      Effect.gen(function* () {
        const { label, expected, mutation } = submission;
        const { expiration } = mutation.authorization;
        let settledAt: bigint | undefined;
        // A reorg can drop or move the enqueue and its settlement, so each
        // poll reads both again.
        while (true) {
          yield* Effect.sleep(Duration.millis(plan.chain.blockTimeMs));
          // Read before the receipt, so a reorg between them cannot make an orphaned receipt look final.
          const latest = (yield* simChain.request({
            method: "eth_getBlockByNumber",
            params: ["latest", false],
          }))!;
          const receipt = yield* simChain.request({
            method: "eth_getTransactionReceipt",
            params: [submission.transactionHash!],
          });
          if (receipt === null) {
            const pending = yield* simChain.request({
              method: "eth_getTransactionByHash",
              params: [submission.transactionHash!],
            });
            if (pending === null) {
              submission.transactionHash = yield* enqueue(calldata);
            }
            continue;
          }
          if (receipt.status !== "0x1") {
            return yield* Effect.die(
              `${label}: enqueue ${receipt.transactionHash} reverted`,
            );
          }
          const head = BigInt(latest.number!);
          // No reorg replaces a block `finalizedBlockDepth` deep, so an
          // enqueue there is never dropped.
          const final =
            head - BigInt(receipt.blockNumber) >=
            BigInt(plan.chain.finalizedBlockDepth);
          if (!expected.executes) {
            if (final) break;
            continue;
          }

          const { args } = decodeEventLog({
            abi: TYPEWRITER_ABI,
            eventName: "ForceInclusionQueued",
            topics: receipt.logs[0]!.topics as [Hex.Hex, ...Hex.Hex[]],
            data: receipt.logs[0]!.data,
            strict: true,
          });
          const settled = yield* simChain.clearedAt(
            app.address,
            queueEntrySlot(args.index),
          );
          if (settled === undefined) {
            // The contract rejects it in every block past its expiration.
            if (
              final &&
              expiration !== 0 &&
              Number(latest.timestamp) > expiration
            ) {
              break;
            }
            continue;
          }
          // A reorg since `latest` moved the settlement past it.
          if (settled > head) continue;
          if (settled !== settledAt) {
            settledAt = settled;
            progressedAt = clock.currentTimeMillisUnsafe();
          }
          // The settlement has no mutation events, so wait for its block's.
          if (
            run.blockEvents.some(
              (event) =>
                event.number === settled && event.status === "finalized",
            )
          ) {
            break;
          }
        }
        pendingEnqueues.delete(label);
      });

    const client = Effect.gen(function* () {
      for (const [index, signer] of signers.entries()) {
        const mutation = deepFreeze(createAccount(manifest, signer));
        const submission: Submission = {
          label: `CreateAccount ${index}`,
          key: mutationKey(mutation.authorization),
          via: "execute",
          mutation,
          expected: { executes: true, errors: [], resubmissionErrors: [] },
          resubmitted: false,
          results: [],
          transactionHash: undefined,
        };
        run.submissions.push(submission);
        yield* execute(submission);
        const [result] = submission.results;
        if (result !== undefined && "error" in result) {
          return yield* Effect.die(`${submission.label}: got ${result.error}`);
        }
      }

      // Each step comes from its own client, so a step does not wait for the
      // one before it to settle.
      const executing: Fiber.Fiber<void, ProgramError>[] = [];
      for (const step of steps) {
        yield* Effect.sleep(Duration.millis(step.delayMs));
        const mutation = deepFreeze(
          sign(
            manifest,
            step.signer,
            withExpiration(plan, step, yield* Clock.currentTimeMillis),
          ),
        );
        const submission: Submission = {
          label: stepLabel(step),
          key: mutationKey(mutation.authorization),
          via: step.via,
          mutation,
          expected: expect(step),
          resubmitted: step.resubmit,
          results: [],
          transactionHash: undefined,
        };
        run.submissions.push(submission);
        if (
          step.mutation.name === "AddCredential" ||
          step.mutation.name === "RemoveCredential"
        ) {
          // Batch sequencing runs built-in mutations first, before steps
          // submitted earlier that may sign with the credential.
          yield* Fiber.joinAll(executing.splice(0));
          yield* execute(submission);
        } else if (step.via === "execute") {
          executing.push(yield* FiberSet.run(fibers, execute(submission)));
        } else {
          const calldata = enqueueCalldata(manifest, step, mutation);
          submission.transactionHash = yield* enqueue(calldata);
          pendingEnqueues.add(submission.label);
          yield* FiberSet.run(fibers, awaitEnqueue(submission, calldata));
        }
      }

      yield* Deferred.await(drained);
      // A rejection's event comes before `execute` returns, and every `execute` must return.
      while (unreturned(run).length > 0 || pendingEnqueues.size > 0) {
        yield* Effect.sleep(Duration.millis(plan.chain.blockTimeMs));
      }
      yield* FiberSet.awaitEmpty(expiryChecks);
      return typewriter;
    });

    return yield* Effect.raceFirst(
      client,
      FiberSet.join(fibers).pipe(Effect.andThen(Effect.never)),
    );
  }).pipe(
    Scope.provide(scope),
    Effect.provideService(
      Database,
      makeDbClient(makeSimDbTransport({ plan, transport, io: scheduler.io })),
    ),
    Effect.provide(layerRpc(transports)),
    Effect.provideService(Clock.Clock, clock),
    Effect.provide(
      Layer.succeed(Random.Random, new Rng(plan.seed, "runtime").toRandom()),
    ),
    // `TYPEWRITER_LOG_LEVEL` applies to the runtime only. The run's own logs
    // print at every level.
    Effect.provide(loggerLayer),
  );

  yield* Effect.logInfo("Started simulation world").pipe(
    Effect.annotateLogs({
      accounts: signers.length,
      steps: steps.length,
      transports: transports.length,
      duration: Math.round(performance.now() - worldStart),
    }),
  );
  const runStart = performance.now();

  // The step loop: run every fiber that can run, then move the clock to the
  // next sleep.
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
    if (next - progressedAt > plan.stallTimeoutMs) {
      return yield* Effect.die(
        `stalled for ${plan.stallTimeoutMs}ms of virtual time, waiting on: ${[...unsettled(run), ...unreturned(run), ...pendingEnqueues].join(", ")}`,
      );
    }
    clock.advanceTo(next);
  }
  const typewriter = yield* exit;
  yield* Effect.logInfo("Settled simulation mutations").pipe(
    Effect.annotateLogs({
      submissions: run.submissions.length,
      virtual_ms: Math.round(clock.currentTimeMillisUnsafe() - startMs),
      duration: Math.round(performance.now() - runStart),
    }),
  );
  const validateStart = performance.now();

  yield* validate({
    app,
    chain,
    db,
    run,
    typewriter,
    ordering: plan.typewriter.ordering,
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
      duration: Math.round(performance.now() - validateStart),
    }),
  );
});

/** What `execute` returned, as the run records it. */
function resultOf(exit: Exit.Exit<void, ExecuteError>): Result {
  if (Exit.isSuccess(exit)) return {};
  const error = Option.getOrUndefined(Cause.findErrorOption(exit.cause));
  return {
    error: error === undefined ? Cause.pretty(exit.cause) : errorName(error),
  };
}

/** Changes every bigint, number, boolean, and hex string that `value` holds. */
function scribble(value: unknown): void {
  if (typeof value !== "object" || value === null) return;
  const entries = value as Record<string, unknown>;
  for (const [key, entry] of Object.entries(entries)) {
    if (typeof entry === "bigint") entries[key] = entry + 1n;
    else if (typeof entry === "number") entries[key] = entry + 1;
    else if (typeof entry === "boolean") entries[key] = !entry;
    else if (typeof entry === "string" && entry.startsWith("0x")) {
      entries[key] = `${entry.slice(0, -1)}${entry.endsWith("0") ? "1" : "0"}`;
    } else scribble(entry);
  }
}

/** The first storage slot of `queue[index]`, which `delete` zeroes once the entry executes. */
function queueEntrySlot(index: bigint): Hex.Hex {
  const queue = STORAGE_LAYOUT.storage.find(({ label }) => label === "queue")!;
  const entry =
    STORAGE_LAYOUT.types["t_struct(QueuedMutation)700_storage"].numberOfBytes;
  // A dynamic array's entries start at the keccak256 of its slot.
  const start = BigInt(
    Hash.keccak256(Hex.fromNumber(BigInt(queue.slot), { size: 32 })),
  );
  return Hex.fromNumber(start + (index * BigInt(entry)) / 32n, { size: 32 });
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
      ({ key, via, resubmitted }) =>
        via === "execute" && (settled.get(key) ?? 0) < (resubmitted ? 2 : 1),
    )
    .map(({ label }) => label);
}

/** The executes, and resubmissions, that have not returned. */
function unreturned(run: Run): string[] {
  return run.submissions
    .filter(
      ({ via, resubmitted, results }) =>
        via === "execute" && results.length < (resubmitted ? 2 : 1),
    )
    .map(({ label }) => `${label} never returned`);
}

BunRuntime.runMain(
  simulate(plan).pipe(
    Effect.tapCause((cause) =>
      Effect.logError("Failed simulation", cause).pipe(
        Effect.annotateLogs({
          reproduce:
            planFile === undefined
              ? `SEED=${plan.seed} bun simulation-test/index.ts`
              : `bun simulation-test/index.ts --plan ${planFile}`,
        }),
      ),
    ),
    Effect.scoped,
    Effect.provide(Logger.layer([logger])),
    Effect.provide(BunServices.layer),
  ),
  { disableErrorReporting: true },
);
