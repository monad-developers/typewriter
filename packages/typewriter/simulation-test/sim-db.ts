import { sql } from "drizzle-orm";
import { Duration, Effect, Schedule } from "effect";
import {
  builder,
  type CompiledStatement,
  compile,
  type DbTransport,
} from "../src/db-transport";
import type { SIM } from "./plan";
import { makeRandom } from "./random";
import type { SimScheduler } from "./scheduler";

/** Postgres fails it as a serialization failure, so its transaction rolls back. */
const ROLLBACK = compile(
  builder.execute(
    sql.raw(
      "DO $$ BEGIN RAISE EXCEPTION 'simulated rollback' USING ERRCODE = 'serialization_failure'; END $$",
    ),
  ),
);

function statementsKey(statements: CompiledStatement[]): string {
  return JSON.stringify(
    statements.map(({ sql, params }) => [sql, params]),
    (_, value) => (typeof value === "bigint" ? value.toString() : value),
  );
}

/**
 * A `DbTransport` that adds latency and errors to `transport`. Postgres runs
 * outside the simulation, so each transaction goes through `io`. The caller
 * then sleeps for a latency drawn from its own generator, keyed by the
 * statements that ran, their parameters, and how many times the transport saw
 * them.
 *
 * A transaction rolls back at a drawn statement at `errorRate`, so the client
 * runs it again. Only its first two attempts can, so the client never runs
 * out of retries.
 */
export function makeSimDbTransport({
  sim,
  transport,
  io,
}: {
  sim: SIM;
  transport: DbTransport;
  io: SimScheduler["io"];
}): DbTransport {
  const {
    latencyMs: [latencyMin, latencyMax],
    errorRate,
  } = sim.db;

  const occurrences = new Map<string, number>();
  const attempts = new Map<string, number>();

  /**
   * Runs `effect` outside the simulation, then sleeps for the latency of
   * `key`. Postgres applies the statements before the sleep, so the caller
   * learns of a write some time after it lands.
   */
  const gate = <a, e>(effect: Effect.Effect<a, e>, key: string) =>
    Effect.gen(function* () {
      const exit = yield* Effect.exit(io(effect));
      const occurrence = occurrences.get(key) ?? 0;
      occurrences.set(key, occurrence + 1);
      const random = yield* makeRandom(
        sim.seed,
        `db:latency:${key}:${occurrence}`,
      );
      yield* Effect.sleep(
        Duration.millis(
          latencyMin + random.nextDoubleUnsafe() * (latencyMax - latencyMin),
        ),
      );
      return yield* exit;
    });

  // A flake of the database retries outside the simulation, as one of Anvil
  // does, so only drawn errors reach the runtime.
  const runOnce = (statements: CompiledStatement[], key: string) =>
    gate(
      transport.run(statements).pipe(
        Effect.retry({
          schedule: Schedule.exponential("10 millis"),
          times: 5,
          while: (error) =>
            error.notApplied === true && error.sql !== ROLLBACK.sql,
        }),
        Effect.catchIf((error) => error.sql !== ROLLBACK.sql, Effect.die),
      ),
      key,
    );

  const rollback = (statements: CompiledStatement[], key: string) =>
    runOnce([...statements, ROLLBACK], key).pipe(
      Effect.andThen(Effect.die(new Error("simulated rollback committed"))),
    );

  const run: DbTransport["run"] = (statements) => {
    const key = statementsKey(statements);
    let attempt = 0;
    return Effect.suspend(() => {
      const current = attempt++;
      return Effect.gen(function* () {
        const seen = attempts.get(key) ?? 0;
        attempts.set(key, seen + 1);
        const random = yield* makeRandom(sim.seed, `db:error:${key}:${seen}`);
        const draw = random.nextDoubleUnsafe();
        const at = Math.floor(
          random.nextDoubleUnsafe() * (statements.length + 1),
        );
        if (current < 2 && draw < errorRate) {
          return yield* rollback(statements.slice(0, at), key);
        }
        return yield* runOnce(statements, key);
      });
    });
  };

  // One runtime runs per simulation, so the lock is never contended.
  const lock: DbTransport["lock"] = () => Effect.succeed(Effect.never);

  return { run, lock };
}
