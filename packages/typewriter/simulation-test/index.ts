import { BunRuntime, BunServices } from "@effect/platform-bun";
import { sql } from "drizzle-orm";
import { Effect, Layer, Random } from "effect";
import { Hex } from "ox";
import { makeDb } from "../src/db";
import { makeChain } from "./chain";
import { int, makeRandom, pick } from "./random";
import { makeSimDb } from "./sim-db";

export type SIM = {
  seed: string;
  chain: { blockTimeMs: number; genesisTimestamp: number };
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

/** The configuration of a run. Each value is drawn from `SEED` and its path. */
export const SIM: SIM = {
  seed: SEED,
  chain: {
    blockTimeMs: pick(SEED, "chain.blockTimeMs", [100, 300, 400, 1_000]),
    genesisTimestamp: 1_700_000_000,
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

/**
 * The `Random` service for the program under test.
 */
export const layerRandom = Layer.effect(
  Random.Random,
  makeRandom(SEED, "runtime"),
);

const program = Effect.gen(function* () {
  const chain = yield* makeChain();
  yield* chain.mine;

  // biome-ignore lint/complexity/useLiteralKeys: `process.env` has an index signature.
  const url = process.env["DATABASE_URL"];
  if (url === undefined) return yield* Effect.die("DATABASE_URL is required");
  const db = makeSimDb({ db: yield* makeDb({ url }) });
  const one = yield* db.query((db) => db.execute(sql`select 1 as one`));
  const two = yield* db.transaction((tx) =>
    tx.query((db) => db.execute(sql`select 2 as two`)),
  );
  console.log([...one, ...two]);
});

BunRuntime.runMain(
  program.pipe(Effect.scoped, Effect.provide(BunServices.layer)),
);
