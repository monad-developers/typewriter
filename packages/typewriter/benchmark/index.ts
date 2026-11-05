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
    yield* Effect.sleep(Duration.millis(plan.chain.blockTimeMs));
    yield* chain.mine(yield* Clock.currentTimeMillis);
  }).pipe(Effect.forever, Effect.forkScoped);

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

  const stats = Effect.tryPromise(() =>
    fetch(`${typewriterUrl}/stats`).then(
      (response) =>
        response.json() as Promise<{
          included: number;
          unincluded: number;
          heapMb: number;
        }>,
    ),
  );
  yield* stats.pipe(
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

  const steps = makeSteps(plan, signers, new Rng(plan.seed, "generator"));
  const samples: { ms: number; error?: string }[] = [];
  let maxUnincluded = 0;
  let latest = yield* Effect.orDie(stats);
  // Each second: whether inclusions keep up with executes, and what the
  // runtime holds that no transaction has included yet.
  yield* Effect.gen(function* () {
    const executed = samples.length;
    yield* Effect.sleep("1 second");
    const previous = latest;
    latest = yield* Effect.orDie(stats);
    maxUnincluded = Math.max(maxUnincluded, latest.unincluded);
    yield* Effect.logInfo("Measured typewriter").pipe(
      Effect.annotateLogs({
        executes: samples.length - executed,
        included: latest.included - previous.included,
        unincluded: latest.unincluded,
        heap_mb: latest.heapMb,
      }),
    );
  }).pipe(Effect.forever, Effect.forkScoped);

  const executes = yield* FiberSet.make();
  const start = performance.now();
  for (const step of steps) {
    yield* Effect.sleep(Duration.millis(step.delayMs));
    const mutation = sign(
      manifest,
      step.signer,
      withExpiration(plan, step, yield* Clock.currentTimeMillis),
    );
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
      yield* FiberSet.run(
        executes,
        execute(mutation).pipe(Effect.map((sample) => samples.push(sample))),
      );
    }
  }
  yield* FiberSet.awaitEmpty(executes);
  const executedMs = performance.now() - start;

  let progressedAt = performance.now();
  let current = yield* Effect.orDie(stats);
  while (current.unincluded > 0) {
    yield* Effect.sleep("100 millis");
    const previous = current;
    current = yield* Effect.orDie(stats);
    if (current.included > previous.included) progressedAt = performance.now();
    if (performance.now() - progressedAt > plan.stallTimeoutMs) {
      return yield* Effect.die(
        `stalled with ${current.unincluded} mutations unincluded`,
      );
    }
  }

  const latencies = samples.map(({ ms }) => ms).toSorted((a, b) => a - b);
  const at = (p: number) =>
    Math.round(latencies[Math.floor(p * (latencies.length - 1))]! * 10) / 10;
  yield* Effect.logInfo("Benchmarked typewriter").pipe(
    Effect.annotateLogs({
      executes: samples.length,
      errors: samples.filter(({ error }) => error !== undefined).length,
      executes_per_second: Math.round((samples.length / executedMs) * 1000),
      execute_p50_ms: at(0.5),
      execute_p90_ms: at(0.9),
      execute_p99_ms: at(0.99),
      execute_max_ms: at(1),
      max_unincluded: maxUnincluded,
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
