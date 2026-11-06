import { BunRuntime, BunServices } from "@effect/platform-bun";
import { SQL } from "bun";
import {
  Cause,
  Clock,
  Duration,
  Effect,
  Exit,
  FiberSet,
  Logger,
  Schedule,
  Semaphore,
} from "effect";
import { ChildProcess } from "effect/process";
import { Hex } from "ox";
import { privateKeyToAccount } from "viem/accounts";
import {
  createAccount,
  deploy,
  enqueueCalldata,
  type Manifest,
  type Mutation,
  makeSigner,
  makeSteps,
  sign,
  withExpiration,
} from "../simulation-test/assessment";
import { ASSESSMENT_ENTRYPOINT } from "../simulation-test/assessment-constants";
import { makeChain } from "../simulation-test/chain";
import type { Plan } from "../simulation-test/plan";
import { Rng } from "../simulation-test/random";
import { makeSimTransport } from "../simulation-test/sim-rpc";
import { KeyType } from "../src/client";
import { createTypewriterApp } from "../src/config";
import { logger } from "../src/logger";
import { loadSolidityApp } from "../src/sol-build";

/**
 * Usage: `DATABASE_URL=<postgres url> bun benchmark/index.ts [--plan <file>]`
 *
 * Runs a simulation plan on the wall clock. This process serves the chain
 * and drives the plan's steps; the runtime runs in `server.ts`, a process of
 * its own.
 */
const args = process.argv.slice(2);
const plan: Plan = await Bun.file(
  args.includes("--plan")
    ? args[args.indexOf("--plan") + 1]!
    : `${import.meta.dir}/plan.json`,
).json();

// biome-ignore lint/complexity/useLiteralKeys: `process.env` has an index signature.
const DATABASE_URL = process.env["DATABASE_URL"];
if (DATABASE_URL === undefined || DATABASE_URL === "") {
  console.error("usage: DATABASE_URL=<postgres url> bun benchmark/index.ts");
  process.exit(1);
}

/** The first Anvil account: the deployer and the scheduler. */
const SCHEDULER_KEY =
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
/** Sends `enqueue` transactions. The second Anvil account. */
const CLIENT = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";

const benchmark = Effect.gen(function* () {
  const scheduler = privateKeyToAccount(SCHEDULER_KEY);
  const chain = yield* makeChain(plan, new Rng(plan.seed, "reorgs"), false);
  const address = yield* deploy({ plan, chain, deployer: scheduler.address });
  const chainId = Number(yield* chain.request({ method: "eth_chainId" }));
  yield* Effect.gen(function* () {
    yield* chain.mine(yield* Clock.currentTimeMillis);
  }).pipe(
    Effect.repeat(Schedule.fixed(Duration.millis(plan.chain.blockTimeMs))),
    Effect.forkScoped,
  );

  // Each of the plan's transports, with its faults, at `/<index>`.
  const transports = plan.transports.map((_, index) =>
    makeSimTransport({ plan, chain, index }),
  );
  const chainServer = yield* Effect.acquireRelease(
    Effect.sync(() =>
      Bun.serve({
        port: 0,
        fetch: async (req) => {
          const transport =
            transports[Number(new URL(req.url).pathname.slice(1))];
          if (transport === undefined) {
            return new Response(null, { status: 404 });
          }
          const { id, method, params } = (await req.json()) as {
            id: number;
            method: never;
            params: never;
          };
          const exit = await Effect.runPromiseExit(
            transport.request({ method, params }),
          );
          if (Exit.isSuccess(exit)) {
            return Response.json({ jsonrpc: "2.0", id, result: exit.value });
          }
          const error = Cause.squash(exit.cause) as {
            _tag?: string;
            error?: unknown;
            status?: number;
            body?: string;
          };
          if (error._tag === "RpcResponseError") {
            return Response.json({ jsonrpc: "2.0", id, error: error.error });
          }
          return new Response(error.body ?? null, {
            status: error.status ?? 503,
          });
        },
      }),
    ),
    (server) => Effect.promise(() => server.stop(true)),
  );

  const database = `typewriter_benchmark_${process.pid}_${Date.now()}`;
  const admin = (statement: string) =>
    Effect.promise(async () => {
      const sql = new SQL({ url: DATABASE_URL, max: 1 });
      await sql.unsafe(statement);
      await sql.close();
    });
  yield* Effect.acquireRelease(admin(`CREATE DATABASE "${database}"`), () =>
    admin(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`),
  );
  const databaseUrl = new URL(DATABASE_URL);
  databaseUrl.pathname = `/${database}`;

  const free = Bun.serve({ port: 0, fetch: () => new Response() });
  const port = free.port;
  free.stop(true);
  const typewriterUrl = `http://localhost:${port}`;
  yield* ChildProcess.make("bun", [`${import.meta.dir}/server.ts`], {
    env: {
      BENCHMARK_CONFIG: JSON.stringify({
        port,
        plan,
        address,
        privateKey: SCHEDULER_KEY,
        chainId,
        rpcUrls: plan.transports.map(
          (_, index) => `${chainServer.url}${index}`,
        ),
        databaseUrl: databaseUrl.toString(),
      }),
    },
    extendEnv: true,
    stdout: "inherit",
    stderr: "inherit",
  }).pipe(Effect.orDie);

  const included = Effect.tryPromise(() =>
    fetch(`${typewriterUrl}/included`).then(
      (response) => response.json() as Promise<number>,
    ),
  );
  yield* included.pipe(
    Effect.retry({ schedule: Schedule.spaced("100 millis"), times: 600 }),
    Effect.orDie,
  );

  const execute = (mutation: Mutation) =>
    Effect.promise(() =>
      fetch(`${typewriterUrl}/execute`, {
        method: "POST",
        body: JSON.stringify(mutation, (_, value) =>
          typeof value === "bigint" ? value.toString() : value,
        ),
      }).then(
        (response) =>
          response.json() as Promise<{ ms: number; error?: string }>,
      ),
    );

  const manifest = createTypewriterApp({
    ...(yield* Effect.promise(() => loadSolidityApp(ASSESSMENT_ENTRYPOINT))),
    config: {
      address,
      account: scheduler,
      chainId,
      hardfork: "MonadTen",
      rpcUrl: "",
      database: { url: "" },
    },
  }).manifest as Manifest;
  const signers = plan.generator.accounts.map((keyType, i) =>
    makeSigner(plan, `account:${i}`, KeyType[keyType]),
  );
  for (const signer of signers) {
    const { error } = yield* execute(createAccount(manifest, signer));
    if (error !== undefined) {
      return yield* Effect.die(`CreateAccount: ${error}`);
    }
  }

  // Signed up front, so that signing does not slow the sends. Each expires
  // from when it is due to be sent.
  const signedAt = yield* Clock.currentTimeMillis;
  let dueMs = 0;
  const steps = makeSteps(plan, signers, new Rng(plan.seed, "generator")).map(
    (step) => {
      dueMs += step.delayMs;
      return {
        step,
        dueMs,
        mutation: sign(
          manifest,
          step.signer,
          withExpiration(plan, step, signedAt + dueMs),
        ),
      };
    },
  );
  const samples: { ms: number; error?: string }[] = [];
  let sent = signers.length;
  let latest = yield* Effect.orDie(included);
  yield* Effect.gen(function* () {
    const executed = samples.length;
    yield* Effect.sleep("1 second");
    const previous = latest;
    latest = yield* Effect.orDie(included);
    yield* Effect.logInfo("Measured typewriter").pipe(
      Effect.annotateLogs({
        executes: samples.length - executed,
        included: latest - previous,
        backlog: sent - latest,
      }),
    );
  }).pipe(Effect.forever, Effect.forkScoped);

  const executes = yield* FiberSet.make();
  // Bun sends at most 256 requests at once, and the chain's share that limit.
  const inFlight = yield* Semaphore.make(240);
  const start = performance.now();
  for (const { step, dueMs, mutation } of steps) {
    // Sent on schedule, and at once when behind it.
    const aheadMs = start + dueMs - performance.now();
    if (aheadMs > 0) yield* Effect.sleep(Duration.millis(aheadMs));
    if (step.via === "enqueue") {
      yield* chain.request({
        method: "eth_sendTransaction",
        params: [
          {
            from: CLIENT,
            to: address,
            data: enqueueCalldata(manifest, step, mutation),
            gas: Hex.fromNumber(1_000_000),
          },
        ],
      });
      continue;
    }
    for (let i = 0; i < (step.resubmit ? 2 : 1); i++) {
      sent++;
      yield* Semaphore.take(inFlight, 1);
      yield* FiberSet.run(
        executes,
        execute(mutation).pipe(
          Effect.map((sample) => samples.push(sample)),
          Effect.ensuring(Semaphore.release(inFlight, 1)),
        ),
      );
    }
  }
  yield* FiberSet.awaitEmpty(executes);

  // A rejected execute is never included.
  const errors = samples.filter(({ error }) => error !== undefined).length;
  let total = yield* Effect.orDie(included);
  let progressedAt = performance.now();
  while (total < sent - errors) {
    yield* Effect.sleep("100 millis");
    const previous = total;
    total = yield* Effect.orDie(included);
    if (total > previous) progressedAt = performance.now();
    if (performance.now() - progressedAt > plan.stallTimeoutMs) {
      return yield* Effect.die(
        `stalled with ${sent - errors - total} mutations unincluded`,
      );
    }
  }
  const includedMs = performance.now() - start;

  const inclusions = yield* Effect.orDie(
    Effect.tryPromise(() =>
      fetch(`${typewriterUrl}/inclusion`).then(
        (response) => response.json() as Promise<number[]>,
      ),
    ),
  );
  const percentile = (values: number[]) => {
    const sorted = values.toSorted((a, b) => a - b);
    return (p: number) =>
      Math.round(sorted[Math.floor(p * (sorted.length - 1))]! * 10) / 10;
  };
  const at = percentile(samples.map(({ ms }) => ms));
  const inclusionAt = percentile(inclusions);
  yield* Effect.logInfo("Benchmarked typewriter").pipe(
    Effect.annotateLogs({
      executes: samples.length,
      errors,
      included_per_second: Math.round((total / includedMs) * 1000),
      execute_p50_ms: at(0.5),
      execute_p90_ms: at(0.9),
      execute_p99_ms: at(0.99),
      execute_max_ms: at(1),
      inclusion_p50_ms: inclusionAt(0.5),
      inclusion_p90_ms: inclusionAt(0.9),
      inclusion_p99_ms: inclusionAt(0.99),
    }),
  );
});

BunRuntime.runMain(
  benchmark.pipe(
    Effect.scoped,
    Effect.provide(Logger.layer([logger])),
    Effect.provide(BunServices.layer),
  ),
);
