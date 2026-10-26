import { PgDialect } from "drizzle-orm/pg-core";
import { Clock, Duration, Effect, Random } from "effect";
import { type Db, DbError, type DbQuery, type DbStatement } from "../src/db";
import { SIM } from "./index";
import { makeRandom } from "./random";
import type { SimScheduler } from "./scheduler";

const dialect = new PgDialect();

/** Ends the run. Inside `io` the clock and randomness are real, so they differ between runs. */
const outside = (service: string) => (): never => {
  throw new Error(`${service} used in a transaction, outside the simulation`);
};

const noClock: Clock.Clock = {
  currentTimeMillisUnsafe: outside("Clock"),
  currentTimeMillis: Effect.sync(outside("Clock")),
  currentTimeNanosUnsafe: outside("Clock"),
  currentTimeNanos: Effect.sync(outside("Clock")),
  monotonicTimeNanosUnsafe: outside("Clock"),
  monotonicTimeNanos: Effect.sync(outside("Clock")),
  sleep: () => Effect.sync(outside("Clock")),
};

const noRandom: Random.Random = {
  nextIntUnsafe: outside("Random"),
  nextDoubleUnsafe: outside("Random"),
};

/**
 * A `Db` that adds latency to `db`. Postgres runs outside the simulation, so
 * each statement outside a transaction, and each whole transaction, goes
 * through `io`. The caller then sleeps for a latency drawn from its own
 * generator, keyed by the statements that ran, their parameters, and how many
 * times the `Db` saw them.
 */
export function makeSimDb({ db, io }: { db: Db; io: SimScheduler["io"] }): Db {
  const {
    latencyMs: [latencyMin, latencyMax],
  } = SIM.db;

  const occurrences = new Map<string, number>();

  /**
   * Runs `effect` outside the simulation, then sleeps for the latency of the
   * `statements` it ran. Postgres applies them before the sleep, so the caller
   * learns of a write some time after it lands.
   */
  const gate = <a, e>(
    effect: Effect.Effect<a, e>,
    statements: () => DbStatement<unknown>[],
  ) =>
    Effect.gen(function* () {
      const result = yield* io(
        // `db` has retried what it could, so an error is a flake of the test.
        effect.pipe(
          Effect.catchIf((error) => error instanceof DbError, Effect.die),
        ),
      );
      const key = JSON.stringify(
        statements().map((statement) => {
          const { sql, params } = dialect.sqlToQuery(statement.getSQL());
          return [sql, params];
        }),
        (_, value) => (typeof value === "bigint" ? value.toString() : value),
      );
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
      return result;
    });

  const query: DbQuery = (build) => {
    // `db` builds the statement again on each retry.
    let statement: DbStatement<unknown> | undefined;
    return gate(
      db.query((client) => {
        const built = build(client);
        statement = built;
        return built;
      }),
      () => [statement!],
    );
  };

  // `f` runs inside `io`, outside the fiber. It cannot have the simulated
  // clock, which moves only between `io` calls, so it has one that ends the
  // run instead of one that differs between runs.
  const transaction: Db["transaction"] = (f) => {
    let statements: DbStatement<unknown>[] = [];
    return gate(
      // @ts-expect-error `gate` runs `f` outside the fiber, so it can't provide services. The runtime's transactions need none.
      db.transaction((tx) => {
        // `db` runs `f` again from the start on each retry.
        statements = [];
        return f({
          query: (build) =>
            tx.query((client) => {
              const statement = build(client);
              statements.push(statement);
              return statement;
            }),
        }).pipe(
          Effect.provideService(Clock.Clock, noClock),
          Effect.provideService(Random.Random, noRandom),
        );
      }),
      () => statements,
    );
  };

  // One runtime runs per simulation, so the lock is never contended.
  const lock: Db["lock"] = () => Effect.succeed(Effect.never);

  return { query, transaction, lock };
}
