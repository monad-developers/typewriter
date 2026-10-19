import { drizzle } from "drizzle-orm/bun-sql";
import { PgDialect } from "drizzle-orm/pg-core";
import { Duration, Effect } from "effect";
import { type Db, DbError, type DbQuery } from "../src/db";
import { SIM } from "./index";
import { makeRandom } from "./random";

/** Builds statements without a connection, to read their SQL. */
const mock = drizzle.mock();
const dialect = new PgDialect();

/**
 * A `Db` that adds latency and faults to `db`. Each statement and each commit
 * draws from its own generator, keyed by the SQL, the parameters, and how many
 * times the `Db` saw them.
 */
export function makeSimDb({ db }: { db: Db }): Db {
  const {
    latencyMs: [latencyMin, latencyMax],
    errorRate,
  } = SIM.db;

  const occurrences = new Map<string, number>();

  /**
   * Sleeps, then fails before `effect`, fails after `effect`, or returns its
   * result, from one draw.
   */
  const gate = <a, e, r>(
    key: string,
    sql: string,
    effect: Effect.Effect<a, e, r>,
  ) =>
    Effect.gen(function* () {
      const occurrence = occurrences.get(key) ?? 0;
      occurrences.set(key, occurrence + 1);
      const random = yield* makeRandom(SIM.seed, `db:${key}:${occurrence}`);

      const draw = random.nextDoubleUnsafe();
      const injected = new DbError({
        sql,
        cause: new Error("simulated database error"),
      });

      const latency =
        latencyMin + random.nextDoubleUnsafe() * (latencyMax - latencyMin);
      yield* Effect.sleep(Duration.millis(latency));

      if (draw < errorRate) return yield* Effect.fail(injected);
      const result = yield* effect;

      return result;
    });

  const wrap =
    (query: DbQuery): DbQuery =>
    (build) =>
      Effect.suspend(() => {
        const { sql, params } = dialect.sqlToQuery(build(mock).getSQL());
        const key = JSON.stringify([sql, params], (_, value) =>
          typeof value === "bigint" ? value.toString() : value,
        );
        return gate(key, sql, query(build));
      });

  const transaction: Db["transaction"] = (f) =>
    gate(
      "COMMIT",
      "COMMIT",
      db.transaction((tx) => f({ query: wrap(tx.query) })),
    );

  return { query: wrap(db.query), transaction };
}
