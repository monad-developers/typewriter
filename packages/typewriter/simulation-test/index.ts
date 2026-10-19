import { BunRuntime, BunServices } from "@effect/platform-bun";
import { Effect, Layer, Random } from "effect";
import { Hex } from "ox";
import { makeChain } from "./chain";
import { int, makeRandom, pick } from "./random";

export type SIM = {
  seed: string;
  chain: { blockTimeMs: number; genesisTimestamp: number };
  transports: {
    latencyMs: [number, number];
    errorRate: number;
    applyThenErrorRate: number;
  }[];
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
});

BunRuntime.runMain(
  program.pipe(Effect.scoped, Effect.provide(BunServices.layer)),
);
