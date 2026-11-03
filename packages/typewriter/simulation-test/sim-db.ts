import { sql } from "drizzle-orm";
import { Duration, Effect, Schedule } from "effect";
import {
  builder,
  type CompiledStatement,
  compile,
  DbError,
  type DbTransport,
} from "../src/db-transport";
import { SIM } from "./index";
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
 * The first attempt of each transaction rolls back at a drawn statement, and
 * the run dies if the client's retry sends different statements. That retry
 * rolls back at `errorRate`, or loses the reply to its `COMMIT` at
 * `commitLostRate`, after Postgres committed or aborted it. Later retries
 * succeed, so the client never runs out of them.
 */
export function makeSimDbTransport({
  transport,
  io,
}: {
  transport: DbTransport;
  io: SimScheduler["io"];
}): DbTransport {
  const {
    latencyMs: [latencyMin, latencyMax],
    errorRate,
    commitLostRate,
  } = SIM.db;

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
        SIM.seed,
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
    let first: string | undefined;
    let attempt = 0;
    return Effect.suspend(() => {
      const key = statementsKey(statements);
      if (first !== undefined && key !== first) {
        return Effect.logError("Transaction diverged on retry").pipe(
          Effect.annotateLogs({ first, retry: key }),
          Effect.andThen(
            Effect.die(
              new Error(`transaction diverged on retry:\n${first}\n${key}`),
            ),
          ),
        );
      }
      first = key;
      const current = attempt++;
      return Effect.gen(function* () {
        const seen = attempts.get(key) ?? 0;
        attempts.set(key, seen + 1);
        const random = yield* makeRandom(SIM.seed, `db:error:${key}:${seen}`);
        const draw = random.nextDoubleUnsafe();
        const at = Math.floor(
          random.nextDoubleUnsafe() * (statements.length + 1),
        );
        if (current === 0 || (current === 1 && draw < errorRate)) {
          return yield* rollback(statements.slice(0, at), key);
        }
        // Only a batch, which starts with its fence, can learn whether it
        // committed. A lost reply elsewhere stops the runtime.
        if (
          current > 1 ||
          draw >= errorRate + commitLostRate ||
          !statements[0]?.sql.includes("typewriter_fence(")
        ) {
          return yield* runOnce(statements, key);
        }

        if (random.nextDoubleUnsafe() < 0.5) {
          yield* runOnce(statements, key);
        } else {
          yield* rollback(statements, key).pipe(
            Effect.catch(() => Effect.void),
          );
        }
        return yield* new DbError({
          sql: "COMMIT",
          cause: new Error("simulated lost reply to COMMIT"),
          commitUnknown: true,
        });
      });
    });
  };

  // One runtime runs per simulation, so the lock is never contended.
  const lock: DbTransport["lock"] = () => Effect.succeed(Effect.never);

  return { run, lock };
}
