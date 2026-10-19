import { BunRuntime, BunServices } from "@effect/platform-bun";
import { Clock, Duration, Effect, type Exit, Layer, Random } from "effect";
import { Hash, Hex } from "ox";
import { privateKeyToAccount } from "viem/accounts";
import { loadSolidityTypewriterApp } from "../src/sol-parse";
import {
  APPS,
  deploy,
  entrypoint,
  type Generator,
  type Mutation,
} from "./apps";
import { type Chain, makeChain } from "./chain";
import { makeSimClock } from "./clock";
import { int, makeRandom, pick } from "./random";
import { makeSimScheduler } from "./scheduler";

export type SIM = {
  seed: string;
  app: string;
  durationMs: number;
  chain: { blockTimeMs: number; genesisTimestamp: number };
  generator: { accounts: number; intervalMs: [number, number] };
  transports: {
    latencyMs: [number, number];
    errorRate: number;
    applyThenErrorRate: number;
  }[];
  db: {
    latencyMs: [number, number];
    errorRate: number;
  };
};

/** The seed for every draw in a run. Set `SEED` to repeat a run. */
// biome-ignore lint/complexity/useLiteralKeys: `process.env` has an index signature.
const SEED = process.env["SEED"] || Hex.random(32);

const APP = process.argv[2];
if (APP === undefined || APPS[APP] === undefined) {
  console.error(
    `usage: bun simulation-test/index.ts <app>, where <app> is one of: ${Object.keys(APPS).join(", ")}`,
  );
  process.exit(1);
}

/** The configuration of a run. Each value is drawn from `SEED` and its path. */
export const SIM: SIM = {
  seed: SEED,
  app: APP,
  durationMs: pick(SEED, "durationMs", [10_000, 60_000, 300_000]),
  chain: {
    blockTimeMs: pick(SEED, "chain.blockTimeMs", [100, 300, 400, 1_000]),
    genesisTimestamp: 1_700_000_000,
  },
  generator: {
    accounts: int(SEED, "generator.accounts", 2, 8),
    intervalMs: pick(SEED, "generator.intervalMs", [
      [1, 10],
      [10, 100],
      [100, 1_000],
    ] as [number, number][]),
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
    errorRate: pick(SEED, "db.errorRate", [0, 0.001, 0.005]),
  },
};

console.log(`simulation seed: ${SEED} (repeat with SEED=${SEED})`);
console.log(JSON.stringify(SIM, null, 2));

export const layerRandom = Layer.effect(
  Random.Random,
  makeRandom(SEED, "runtime"),
);

/** The program under test. */
type Target = {
  execute: (mutation: Mutation) => Effect.Effect<unknown, unknown>;
};

// TODO(sim) run the typewriter runtime here once it uses `Db` from `db.ts`.
const target: Target = {
  execute: () => Effect.succeed({ status: "unwired" }),
};

type TraceEntry = { t: number } & (
  | { kind: "block"; timestamp: number }
  | { kind: "submit"; id: number; name: string }
  | { kind: "result"; id: number; exit: string }
);

type RunResult = {
  trace: TraceEntry[];
  traceHash: Hex.Hex;
  steps: number;
  virtualMs: number;
  /** The exit of the simulation if it stopped before `SIM.durationMs`. */
  exit: Exit.Exit<unknown, unknown> | undefined;
};

/** Runs the simulation for `SIM.durationMs` of virtual time. */
async function run({
  chain,
  generator,
}: {
  chain: Chain;
  generator: Generator;
}): Promise<RunResult> {
  const startMs = SIM.chain.genesisTimestamp * 1000;
  const endMs = startMs + SIM.durationMs;
  const scheduler = makeSimScheduler(
    Effect.runSync(makeRandom(SIM.seed, "scheduler")),
  );
  const clock = makeSimClock(startMs, scheduler.schedule);
  const generatorRandom = Effect.runSync(makeRandom(SIM.seed, "generator"));

  // The chain runs outside the simulation.
  const simChain: Chain = {
    request: (request) => scheduler.io(chain.request(request)),
    mine: (timestamp) => scheduler.io(chain.mine(timestamp)),
  };

  const trace: TraceEntry[] = [];
  const record = (entry: Omit<TraceEntry, "t"> & Partial<TraceEntry>) =>
    Effect.sync(() => {
      trace.push({
        t: clock.currentTimeMillisUnsafe() - startMs,
        ...entry,
      } as TraceEntry);
    });

  const between = ([min, max]: [number, number]) =>
    Duration.millis(min + generatorRandom.nextDoubleUnsafe() * (max - min));

  const miner = Effect.gen(function* () {
    yield* Effect.sleep(Duration.millis(SIM.chain.blockTimeMs));
    // Anvil takes whole seconds, so blocks in the same second share a timestamp.
    const timestamp = Math.floor((yield* Clock.currentTimeMillis) / 1000);
    yield* simChain.mine(timestamp);
    yield* record({ kind: "block", timestamp });
  }).pipe(Effect.forever);

  let nextId = 0;
  const submitter = Effect.gen(function* () {
    yield* Effect.sleep(between(SIM.generator.intervalMs));
    const mutation = generator.next(
      generatorRandom,
      yield* Clock.currentTimeMillis,
    );
    const id = nextId++;
    yield* record({ kind: "submit", id, name: mutation.name });
    // Each mutation comes from its own client, so the submitter does not wait.
    yield* target.execute(mutation).pipe(
      Effect.exit,
      Effect.flatMap((exit) =>
        record({ kind: "result", id, exit: String(exit) }),
      ),
      Effect.forkChild,
    );
  }).pipe(Effect.forever);

  const world = Effect.all([miner, submitter], {
    concurrency: "unbounded",
  }).pipe(
    Effect.provideService(Clock.Clock, clock),
    Effect.provide(layerRandom),
  );

  let exit: Exit.Exit<unknown, unknown> | undefined;
  const fiber = Effect.runFork(world, { scheduler });
  fiber.addObserver((result) => {
    exit = result;
  });

  let steps = 0;
  while (exit === undefined) {
    await scheduler.runUntilIdle();
    if (exit !== undefined) break;
    const next = clock.nextWakeup();
    if (next === undefined) {
      throw new Error("deadlock: no fiber can run and no sleep is pending");
    }
    if (next > endMs) break;
    clock.advanceTo(next);
    steps++;
  }

  const early = exit;
  if (early === undefined) {
    fiber.interruptUnsafe();
    await scheduler.runUntilIdle();
  }

  const json = JSON.stringify(trace, (_, value) =>
    typeof value === "bigint" ? value.toString() : value,
  );
  return {
    trace,
    traceHash: Hash.keccak256(Hex.fromString(json)),
    steps,
    virtualMs: clock.currentTimeMillisUnsafe() - startMs,
    exit: early,
  };
}

/** The first Anvil account. */
const SCHEDULER = privateKeyToAccount(
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
);

const program = Effect.gen(function* () {
  const app = APPS[SIM.app]!;
  const chain = yield* makeChain();
  const address = yield* deploy({ app, chain, deployer: SCHEDULER.address });
  const chainId = Number(yield* chain.request({ method: "eth_chainId" }));
  const internal = yield* Effect.promise(() =>
    loadSolidityTypewriterApp(entrypoint(app), {
      address,
      account: SCHEDULER,
      chainId,
      rpcUrl: "sim-0",
      database: { url: "unused" },
    }),
  );

  const wallStart = performance.now();
  const result = yield* Effect.promise(() =>
    run({ chain, generator: app.makeGenerator(internal.manifest) }),
  );
  const count = (kind: string) =>
    result.trace.filter((entry) => entry.kind === kind).length;

  console.log({
    app: SIM.app,
    address,
    steps: result.steps,
    blocks: count("block"),
    mutations: count("submit"),
    virtualMs: result.virtualMs,
    wallMs: Math.round(performance.now() - wallStart),
    traceHash: result.traceHash,
  });
  if (result.exit !== undefined) {
    return yield* Effect.die(result.exit);
  }
});

BunRuntime.runMain(
  program.pipe(Effect.scoped, Effect.provide(BunServices.layer)),
);
