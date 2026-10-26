import { SQL } from "bun";
import { DrizzleQueryError, type SQLWrapper } from "drizzle-orm";
import { type BunSQLDatabase, drizzle } from "drizzle-orm/bun-sql";
import { PgDialect } from "drizzle-orm/pg-core";
import {
  Context,
  Data,
  Deferred,
  Effect,
  Exit,
  Layer,
  Schedule,
  type Scope,
} from "effect";

export type DatabaseOptions = {
  url: string;
  maxConnections?: number;
  statementTimeoutMs?: number;
  idleInTransactionTimeoutMs?: number;
};

export type DbClient = BunSQLDatabase;

export type DbStatement<result> = PromiseLike<result> & SQLWrapper;

/** `build` must only build the statement, not run it. */
export type DbQuery = <result>(
  build: (db: DbClient) => DbStatement<result>,
) => Effect.Effect<result, DbError>;

export type DbTransaction = {
  query: DbQuery;
};

/** Retries run a transaction again from the start, so `f` can run more than once. */
export type Db = {
  query: DbQuery;
  transaction: <a, e, r>(
    f: (tx: DbTransaction) => Effect.Effect<a, e, r>,
  ) => Effect.Effect<a, e | DbError, r>;
  /**
   * Hold the advisory lock `key` until the scope closes. The result fails when
   * the lock is lost, so run it in a race with the work that needs the lock.
   */
  lock: (
    key: bigint,
    timeoutMs: number,
  ) => Effect.Effect<Effect.Effect<never, DbError>, DbError, Scope.Scope>;
};

export class Database extends Context.Service<Database, Db>()(
  "typewriter/Database",
) {}

export const layerDatabase = (
  options: DatabaseOptions,
): Layer.Layer<Database> => Layer.effect(Database, makeDb(options));

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

const dialect = new PgDialect();

const LOCK_SQL = "SELECT pg_advisory_lock($1::bigint)";
const COMMIT_STATUS_SQL = "select pg_xact_status($1::xid8) as status";

/** The transaction's `COMMIT` hasn't finished, so check its status again. */
class CommitInProgressError extends Data.TaggedError("CommitInProgressError") {}

export function statementSql(statement: SQLWrapper): string {
  return dialect.sqlToQuery(statement.getSQL()).sql;
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

function makeQuery(db: DbClient, inTransaction: boolean): DbQuery {
  return (build) =>
    Effect.suspend(() => {
      const statement = build(db);
      return Effect.tryPromise({
        try: () => statement,
        catch: (cause) =>
          new DbError({
            sql: statementSql(statement),
            cause,
            notApplied:
              hasCode(cause, NOT_APPLIED) ||
              (inTransaction && hasCode(cause, CONNECTION_LOST)),
          }),
      });
    });
}

function retry<a, e, r>(effect: Effect.Effect<a, e, r>) {
  return effect.pipe(
    Effect.retry({
      schedule: Schedule.exponential("10 millis").pipe(Schedule.jittered),
      times: 4,
      while: (error) => error instanceof DbError && error.notApplied === true,
    }),
  );
}

export function makeDb(
  options: DatabaseOptions,
): Effect.Effect<Db, never, Scope.Scope> {
  return Effect.gen(function* () {
    const idleInTransactionTimeoutMs =
      options.idleInTransactionTimeoutMs ?? 30_000;
    const client = yield* Effect.acquireRelease(
      Effect.sync(
        () =>
          new SQL({
            url: options.url,
            max: options.maxConnections,
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

    const query = makeQuery(drizzle({ client }), false);

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
    const transaction: Db["transaction"] = <a, e, r>(
      f: (tx: DbTransaction) => Effect.Effect<a, e, r>,
    ) =>
      Effect.flatMap(Effect.context<r>(), (context) =>
        Effect.callback<a, e | DbError>((resume) => {
          const controller = new AbortController();
          let exit: Exit.Exit<a, e> | undefined;
          // A failed statement aborts the transaction, even if `f` recovers.
          let failed: DbError | undefined;
          // Set before `COMMIT`. A transaction without an id wrote nothing.
          let xid: string | null | undefined;
          const done = client
            .begin(async (tx) => {
              const query = makeQuery(drizzle({ client: tx }), true);
              exit = await Effect.runPromiseExitWith(context)(
                Effect.suspend(() =>
                  f({
                    query: (build) =>
                      query(build).pipe(
                        Effect.tapError((error) =>
                          Effect.sync(() => {
                            failed ??= error;
                          }),
                        ),
                      ),
                  }),
                ),
                { signal: controller.signal },
              );
              if (Exit.isFailure(exit)) throw exit;
              if (failed !== undefined) throw failed;
              [{ xid }] =
                await tx`select pg_current_xact_id_if_assigned()::text as xid`;
              return exit.value;
            })
            .then(
              (value) => resume(Effect.succeed(value as a)),
              (cause) => {
                if (exit !== undefined && Exit.isFailure(exit)) {
                  return resume(exit);
                }
                if (failed !== undefined) return resume(Effect.fail(failed));
                // Postgres rolls back unless it ran `COMMIT`.
                if (exit === undefined || xid === undefined) {
                  return resume(
                    Effect.fail(
                      new DbError({
                        sql:
                          exit === undefined
                            ? "BEGIN"
                            : "select pg_current_xact_id_if_assigned()",
                        cause,
                        notApplied: true,
                      }),
                    ),
                  );
                }
                // Postgres answered `COMMIT` with an error, so it rolled back.
                if (
                  hasCode(cause, SERVER_ERROR) &&
                  !hasCode(cause, CONNECTION_LOST)
                ) {
                  return resume(
                    Effect.fail(
                      new DbError({
                        sql: "COMMIT",
                        cause,
                        notApplied: hasCode(cause, NOT_APPLIED),
                      }),
                    ),
                  );
                }
                const value = exit.value;
                if (xid === null) return resume(Effect.succeed(value));
                // `COMMIT` may have run.
                resume(
                  commitStatus(xid).pipe(
                    Effect.flatMap((status) =>
                      status === "committed"
                        ? Effect.succeed(value)
                        : Effect.fail(
                            new DbError({
                              sql: "COMMIT",
                              cause,
                              notApplied: status === "aborted",
                            }),
                          ),
                    ),
                  ),
                );
              },
            )
            .finally(() => controller.abort());
          return Effect.promise(() => {
            controller.abort();
            return done;
          });
        }),
      ).pipe(retry);

    // The lock belongs to one session, so it has its own connection, which
    // Bun must not close. Closing it ends the session and releases the lock.
    const lock: Db["lock"] = (key, timeoutMs) =>
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

    return {
      query: (build) => query(build).pipe(retry),
      transaction,
      lock,
    };
  });
}
