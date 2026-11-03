import { SQL } from "bun";
import { DrizzleQueryError, type SQLWrapper } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sql";
import { PgDialect } from "drizzle-orm/pg-core";
import { Data, Deferred, Effect, Schedule, type Scope } from "effect";

export type PostgresOptions = {
  url: string;
  maxConnections?: number;
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
}> {
  override get message() {
    const sql = this.sql.replaceAll(/\s+/g, " ").trim();
    return `Failed database query: ${sql.length > 120 ? `${sql.slice(0, 120)}...` : sql}`;
  }
}

const LOCK_SQL = "SELECT pg_advisory_lock($1::bigint)";
const XID_SQL = "select pg_current_xact_id_if_assigned()::text as xid";
const COMMIT_STATUS_SQL = "select pg_xact_status($1::xid8) as status";

/** The transaction's `COMMIT` hasn't finished, so check its status again. */
class CommitInProgressError extends Data.TaggedError("CommitInProgressError") {}

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
    const idleInTransactionTimeoutMs =
      options.idleInTransactionTimeoutMs ?? 30_000;
    const client = yield* Effect.acquireRelease(
      Effect.sync(
        () =>
          new SQL({
            url: options.url,
            max: options.maxConnections,
            bigint: true,
            // Prepared statements store drizzle's `jsonb` values as JSON strings.
            prepare: false,
            connection: {
              statement_timeout: String(options.statementTimeoutMs ?? 30_000),
              idle_in_transaction_session_timeout: String(
                idleInTransactionTimeoutMs,
              ),
            },
          }),
      ),
      (client) => Effect.promise(() => client.close()),
    );

    // The status of a transaction whose `COMMIT` got no answer, or `undefined`.
    // It uses its own connection, since the pool may be busy or failing.
    const commitStatus = (xid: string) =>
      Effect.acquireUseRelease(
        Effect.sync(
          () => new SQL({ url: options.url, max: 1, prepare: false }),
        ),
        (checker) =>
          Effect.gen(function* () {
            const [row] = yield* Effect.tryPromise({
              try: () => checker`select pg_xact_status(${xid}::xid8) as status`,
              catch: (cause) => new DbError({ sql: COMMIT_STATUS_SQL, cause }),
            });
            // Postgres aborts a transaction whose session ends before `COMMIT`.
            if (row?.status === "in progress") {
              return yield* new CommitInProgressError();
            }
            return row?.status as string | null | undefined;
          }).pipe(Effect.retry({ schedule: Schedule.spaced("100 millis") })),
        (checker) => Effect.promise(() => checker.close()),
      ).pipe(
        Effect.timeout(idleInTransactionTimeoutMs + 5_000),
        Effect.orElseSucceed(() => undefined),
      );

    // Not `reserve`: after a lost connection, a reserved connection can run
    // later statements on another session.
    const run: DbTransport["run"] = (statements) =>
      Effect.promise(async (): Promise<Effect.Effect<unknown[], DbError>> => {
        // The statement that runs: -1 for `BEGIN`, `statements.length` for the xid.
        let at = -1;
        // Set before `COMMIT`. A transaction without an id wrote nothing.
        let xid: string | null | undefined;
        const results: unknown[] = [];
        try {
          await client.begin(async (tx) => {
            for (at = 0; at < statements.length; at++) {
              const { sql, params } = statements[at]!;
              results.push(await tx.unsafe(sql, params));
            }
            [{ xid }] = await tx.unsafe(XID_SQL);
          });
          return Effect.succeed(results);
        } catch (cause) {
          // Postgres rolls back unless it ran `COMMIT`.
          if (xid === undefined) {
            return Effect.fail(
              new DbError({
                sql: at < 0 ? "BEGIN" : (statements[at]?.sql ?? XID_SQL),
                cause,
                notApplied:
                  at < 0 ||
                  at === statements.length ||
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
            return Effect.fail(
              new DbError({
                sql: "COMMIT",
                cause,
                notApplied: hasCode(cause, NOT_APPLIED),
              }),
            );
          }
          if (xid === null) return Effect.succeed(results);
          // `COMMIT` may have run.
          return commitStatus(xid).pipe(
            Effect.flatMap((status) =>
              status === "committed"
                ? Effect.succeed(results)
                : Effect.fail(
                    new DbError({
                      sql: "COMMIT",
                      cause,
                      notApplied: status === "aborted",
                    }),
                  ),
            ),
          );
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
