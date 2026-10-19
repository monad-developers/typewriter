import { Effect, Random } from "effect";
import { Hash, Hex } from "ox";

/**
 * Makes a stateful generator from `seed` and `domain`. Each domain gives its
 * own stream, so draws from one generator do not shift the draws of another.
 */
export function makeRandom(seed: string, domain: string) {
  return Effect.service(Random.Random).pipe(
    Random.withSeed(Hash.keccak256(Hex.fromString(`${seed}:${domain}`))),
  );
}

/** Draws one number in [0, 1) from `seed` and `domain`. */
function draw(seed: string, domain: string): number {
  return Effect.runSync(makeRandom(seed, domain)).nextDoubleUnsafe();
}

/** Picks one of `values` from `seed` and `domain`. */
export function pick<const value>(
  seed: string,
  domain: string,
  values: readonly value[],
): value {
  return values[Math.floor(draw(seed, domain) * values.length)]!;
}

/** Draws an integer in [min, max] from `seed` and `domain`. */
export function int(
  seed: string,
  domain: string,
  min: number,
  max: number,
): number {
  return min + Math.floor(draw(seed, domain) * (max - min + 1));
}
