import { PgDialect } from "drizzle-orm/pg-core";
import { Clock, Data, Duration, Effect, Random, Schedule } from "effect";
import {
  DbError,
  type DbQuery,
  type DbStatement,
  type DbTransport,
} from "../src/db-transport";
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

/** A rollback a transaction drew. It reaches the client as a `DbError`, after the latency. */
class InjectedRollback extends Data.TaggedError("InjectedRollback") {}

function statementsKey(statements: DbStatement<unknown>[]): string {
  return JSON.stringify(
    statements.map((statement) => {
      const { sql, params } = dialect.sqlToQuery(statement.getSQL());
      return [sql, params];
    }),
    (_, value) => (typeof value === "bigint" ? value.toString() : value),
  );
}

/**
 * A `DbTransport` that adds latency and errors to `transport`. Postgres runs
 * outside the simulation, so each statement outside a transaction, and
 * each whole transaction, goes through `io`. The caller then sleeps for a
 * latency drawn from its own generator, keyed by the statements that ran,
 * their parameters, and how many times the transport saw them. A transaction
 * that draws an error rolls back after `f` ran, so the client runs it again.
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
  } = SIM.db;

  const occurrences = new Map<string, number>();
  const attempts = new Map<string, number>();

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
      const exit = yield* Effect.exit(
        io(
          // A flake of the database retries outside the simulation, as one of
          // Anvil does, so only drawn errors reach the runtime.
          effect.pipe(
            Effect.retry({
              schedule: Schedule.exponential("10 millis"),
              times: 5,
              while: (error) =>
                error instanceof DbError && error.notApplied === true,
            }),
            Effect.catchIf((error) => error instanceof DbError, Effect.die),
          ),
        ),
      );
      const key = statementsKey(statements());
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

  /** Whether the transaction that ran `statements` rolls back, at the drawn rate. */
  const drawRollback = (statements: DbStatement<unknown>[]) =>
    Effect.gen(function* () {
      const key = statementsKey(statements);
      const attempt = attempts.get(key) ?? 0;
      attempts.set(key, attempt + 1);
      const random = yield* makeRandom(SIM.seed, `db:error:${key}:${attempt}`);
      return random.nextDoubleUnsafe() < errorRate;
    });

  const query: DbQuery = (build) => {
    let statement: DbStatement<unknown> | undefined;
    return gate(
      transport.query((client) => {
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
  // Each run of the effect, as the client's retries run it again, starts its
  // own statements and draw.
  const transaction: DbTransport["transaction"] = (f) =>
    Effect.suspend(() => {
      let statements: DbStatement<unknown>[] = [];
      // Drawn once, so a flake that runs `f` again draws nothing more.
      let rollback: boolean | undefined;
      return gate(
        // @ts-expect-error `gate` runs `f` outside the fiber, so it can't provide services. The runtime's transactions need none.
        transport.transaction((tx) => {
          // A flake runs `f` again from the start.
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
            Effect.tap(() =>
              Effect.gen(function* () {
                rollback ??= yield* drawRollback(statements);
                if (rollback) return yield* new InjectedRollback();
              }),
            ),
          );
        }),
        () => statements,
      ).pipe(
        Effect.mapError((error) =>
          error instanceof InjectedRollback
            ? new DbError({
                sql: "COMMIT",
                cause: new Error("simulated serialization failure"),
                notApplied: true,
              })
            : error,
        ),
      );
    });

  // One runtime runs per simulation, so the lock is never contended.
  const lock: DbTransport["lock"] = () => Effect.succeed(Effect.never);

  return { query, transaction, lock };
}
