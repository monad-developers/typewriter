declare global {
  /**
   * Turns on the runtime's internal assertions. `bunfig.toml` defines it true
   * for tests and the simulation, and `bun run build` defines it false so the
   * bundler drops every `if (globalThis.DEBUG)` block. Code that imports the
   * source without either define leaves it undefined, so the checks stay off.
   */
  var DEBUG: boolean | undefined;
}

/** An internal invariant does not hold, so the runtime has a bug. */
export class AssertionError extends Error {
  override name = "AssertionError";
}

/**
 * Throws an {@link AssertionError} when `condition` is false. Call it only
 * inside `if (globalThis.DEBUG)`, so that production builds drop the check
 * and the work to compute its arguments.
 */
export function assert(
  condition: unknown,
  message: () => string,
): asserts condition {
  if (!condition) throw new AssertionError(message());
}
