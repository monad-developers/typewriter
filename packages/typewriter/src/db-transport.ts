import { SQL } from "bun";
import { DrizzleQueryError, type SQLWrapper } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sql";
import { PgDialect } from "drizzle-orm/pg-core";
import { Data, Deferred, Effect, Exit, type Scope } from "effect";

export type PostgresOptions = {
  url: string;
  maxConnections?: number;
  /** Postgres's `statement_timeout`, and how long a whole `run` waits for an answer. */
  statementTimeoutMs?: number;
  idleInTransactionTimeoutMs?: number;
};

/** Builds statements for `Db.run`. It cannot run them. */
export const builder = drizzle.mock();

export type DbStatement<result> = PromiseLike<result> & SQLWrapper;

/**
 * Runs statements on one database driver. A transport does not retry: it sets
 * `notApplied` on a failure that is safe to retry.
 */
export type DbTransport = {
  /** Runs `statements` in one transaction, in order, and returns their results. */
  run: (statements: CompiledStatement[]) => Effect.Effect<unknown[], DbError>;
  /**
   * Hold the advisory lock `key` until the scope closes. The result fails when
   * the lock is lost, so run it in a race with the work that needs the lock.
   */
  lock: (
    key: bigint,
    timeoutMs: number,
  ) => Effect.Effect<Effect.Effect<never, DbError>, DbError, Scope.Scope>;
};

export class DbError extends Data.TaggedError("DbError")<{
  sql: string;
  cause: unknown;
  /** Set when the work is known to have not applied, so a retry is safe. */
  notApplied?: boolean;
  /** Set when `COMMIT` got no answer, so the transaction may have committed. */
  commitUnknown?: boolean;
}> {
  override get message() {
    const sql = this.sql.replaceAll(/\s+/g, " ").trim();
    return `Failed database query: ${sql.length > 120 ? `${sql.slice(0, 120)}...` : sql}`;
  }
}

const LOCK_SQL = "SELECT pg_advisory_lock($1::bigint)";

/** A statement whose SQL and parameters are fixed. */
export type CompiledStatement = { sql: string; params: unknown[] };

const dialect = new PgDialect();

/**
 * Fixes the SQL and parameters of `statement` now, so later changes to the
 * values it was built from don't reach the database.
 */
export function compile(statement: SQLWrapper): CompiledStatement {
  const { sql, params } = dialect.sqlToQuery(statement.getSQL());
  return { sql, params: structuredClone(params) };
}

/** Codes after which a statement did not apply. */
const NOT_APPLIED = new Set([
  "ERR_POSTGRES_CONNECTION_REFUSED",
  "40001", // serialization_failure
  "40P01", // deadlock_detected
]);

/** Codes for a lost connection. Postgres then rolls back an open transaction. */
const CONNECTION_LOST = new Set([
  "ERR_POSTGRES_CONNECTION_CLOSED",
  "ERR_POSTGRES_CONNECTION_FAILED",
  "ERR_POSTGRES_CONNECTION_TIMEOUT",
  "ERR_POSTGRES_IDLE_TIMEOUT",
  "ERR_POSTGRES_LIFETIME_TIMEOUT",
  "ERR_POSTGRES_EXPECTED_REQUEST",
  "57P01", // admin_shutdown
  "57P02", // crash_shutdown
  "57P03", // cannot_connect_now
]);

/** The code for an error that Postgres sent. */
const SERVER_ERROR = new Set(["ERR_POSTGRES_SERVER_ERROR"]);

function hasCode(cause: unknown, codes: Set<string>): boolean {
  const error = (cause instanceof DrizzleQueryError ? cause.cause : cause) as
    | { code?: unknown; errno?: unknown }
    | undefined;
  return [error?.code, error?.errno].some(
    (code) => typeof code === "string" && codes.has(code),
  );
}

export function makePostgresTransport(
  options: PostgresOptions,
): Effect.Effect<DbTransport, never, Scope.Scope> {
  return Effect.gen(function* () {
    const timeoutMs = options.statementTimeoutMs ?? 30_000;
    const idleInTransactionTimeoutMs =
      options.idleInTransactionTimeoutMs ?? 30_000;
    const client = yield* Effect.acquireRelease(
      Effect.sync(
        () =>
          new SQL({
            url: options.url,
            max: options.maxConnections,
            bigint: true,
            connection: {
              statement_timeout: String(timeoutMs),
              idle_in_transaction_session_timeout: String(
                idleInTransactionTimeoutMs,
              ),
            },
          }),
      ),
      // Runs are uninterruptible, so only those past their deadline remain.
      (client) => Effect.promise(() => client.close({ timeout: 0 })),
    );

    // Not `reserve`: after a lost connection, a reserved connection can run
    // later statements on another session.
    const run: DbTransport["run"] = (statements) =>
      Effect.promise(async () => {
        // The statement that runs: -1 for `BEGIN`, `statements.length` for `COMMIT`.
        let at = -1;
        let expired = false;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const results: unknown[] = [];
        try {
          await Promise.race([
            client.begin(async (tx) => {
              // Sent without waiting, so they share round trips.
              const settled = await Promise.allSettled(
                statements.map(({ sql, params }) =>
                  tx.unsafe(sql, params).execute(),
                ),
              );
              for (at = 0; at < settled.length; at++) {
                const result = settled[at]!;
                if (result.status === "rejected") throw result.reason;
                results.push(result.value);
              }
              // The run already failed as not applied, so it must not commit.
              if (expired) throw new Error("Deadline passed before COMMIT");
            }),
            // A silently dropped connection never answers.
            new Promise((_, reject) => {
              timer = setTimeout(() => {
                expired = true;
                reject(new Error(`No answer within ${timeoutMs}ms`));
              }, timeoutMs);
            }),
          ]);
          return Exit.succeed(results);
        } catch (cause) {
          // Postgres rolls back unless it ran `COMMIT`.
          if (at < statements.length) {
            return Exit.fail(
              new DbError({
                sql: statements[at]?.sql ?? "BEGIN",
                cause,
                notApplied:
                  at < 0 ||
                  hasCode(cause, NOT_APPLIED) ||
                  hasCode(cause, CONNECTION_LOST),
              }),
            );
          }
          // Postgres answered `COMMIT` with an error, so it rolled back.
          if (
            hasCode(cause, SERVER_ERROR) &&
            !hasCode(cause, CONNECTION_LOST)
          ) {
            return Exit.fail(
              new DbError({
                sql: "COMMIT",
                cause,
                notApplied: hasCode(cause, NOT_APPLIED),
              }),
            );
          }
          return Exit.fail(
            new DbError({ sql: "COMMIT", cause, commitUnknown: true }),
          );
        } finally {
          clearTimeout(timer);
        }
      }).pipe(Effect.flatten, Effect.uninterruptible);

    // The lock belongs to one session, so it has its own connection, which
    // Bun must not close. Closing it ends the session and releases the lock.
    const lock: DbTransport["lock"] = (key, timeoutMs) =>
      Effect.gen(function* () {
        const lost = yield* Deferred.make<never, DbError>();
        const client = yield* Effect.acquireRelease(
          Effect.sync(
            () =>
              new SQL({
                url: options.url,
                max: 1,
                prepare: false,
                idleTimeout: 0,
                maxLifetime: 0,
                connection: { lock_timeout: `${timeoutMs}ms` },
                onclose: (cause) =>
                  Deferred.doneUnsafe(
                    lost,
                    Effect.fail(new DbError({ sql: LOCK_SQL, cause })),
                  ),
              }),
          ),
          (client) => Effect.promise(() => client.close()),
        );
        yield* Effect.tryPromise({
          try: () => client`SELECT pg_advisory_lock(${key.toString()}::bigint)`,
          catch: (cause) => new DbError({ sql: LOCK_SQL, cause }),
        });
        return Deferred.await(lost);
      });

    return { run, lock };
  });
}
