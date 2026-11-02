import { PGlite } from "@electric-sql/pglite";
import { SQL } from "bun";
import { DrizzleQueryError, type SQLWrapper } from "drizzle-orm";
import { drizzle as drizzleBunSql } from "drizzle-orm/bun-sql";
import {
  type PgDatabase,
  PgDialect,
  type PgQueryResultHKT,
} from "drizzle-orm/pg-core";
import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import { Data, Deferred, Effect, Exit, Schedule, type Scope } from "effect";

export type PostgresOptions = {
  kind?: "postgres";
  url: string;
  maxConnections?: number;
  statementTimeoutMs?: number;
  idleInTransactionTimeoutMs?: number;
};

export type Drizzle = PgDatabase<PgQueryResultHKT>;

export type DbStatement<result> = PromiseLike<result> & SQLWrapper;

/** `build` must only build the statement, not run it. */
export type DbQuery = <result>(
  build: (db: Drizzle) => DbStatement<result>,
) => Effect.Effect<result, DbError>;

export type DbTransaction = {
  query: DbQuery;
};

/**
 * Runs statements on one database driver. A transport does not retry: it sets
 * `notApplied` on a failure that is safe to retry.
 */
export type DbTransport = {
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

export function statementSql(statement: SQLWrapper): string {
  return dialect.sqlToQuery(statement.getSQL()).sql;
}

function makeQuery(
  db: Drizzle,
  notApplied: (cause: unknown) => boolean,
): DbQuery {
  return (build) =>
    Effect.suspend(() => {
      const statement = build(db);
      return Effect.tryPromise({
        try: () => statement,
        catch: (cause) =>
          new DbError({
            sql: statementSql(statement),
            cause,
            notApplied: notApplied(cause),
          }),
      });
    });
}

/**
 * Runs `f` in the transaction that `begin` opens and commits once `run`
 * resolves. `commitFailed` decides the result when the transaction fails
 * after `f` succeeded.
 */
function runTransaction<a, e, r>(
  f: (tx: DbTransaction) => Effect.Effect<a, e, r>,
  begin: (run: (query: DbQuery) => Promise<a>) => Promise<a>,
  commitFailed: (cause: unknown, value: a) => Effect.Effect<a, DbError>,
): Effect.Effect<a, e | DbError, r> {
  return Effect.flatMap(Effect.context<r>(), (context) =>
    Effect.callback<a, e | DbError>((resume) => {
      const controller = new AbortController();
      let exit: Exit.Exit<a, e> | undefined;
      // A failed statement aborts the transaction, even if `f` recovers.
      let failed: DbError | undefined;
      const done = begin(async (query) => {
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
        return exit.value;
      })
        .then(
          (value) => resume(Effect.succeed(value)),
          (cause) => {
            if (exit !== undefined && Exit.isFailure(exit)) {
              return resume(exit);
            }
            if (failed !== undefined) return resume(Effect.fail(failed));
            if (exit === undefined) {
              return resume(
                Effect.fail(
                  new DbError({ sql: "BEGIN", cause, notApplied: true }),
                ),
              );
            }
            resume(commitFailed(cause, exit.value));
          },
        )
        .finally(() => controller.abort());
      return Effect.promise(() => {
        controller.abort();
        return done;
      });
    }),
  );
}

const LOCK_SQL = "SELECT pg_advisory_lock($1::bigint)";
const COMMIT_STATUS_SQL = "select pg_xact_status($1::xid8) as status";

/** The transaction's `COMMIT` hasn't finished, so check its status again. */
class CommitInProgressError extends Data.TaggedError("CommitInProgressError") {}

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

    const query = makeQuery(drizzleBunSql({ client }), (cause) =>
      hasCode(cause, NOT_APPLIED),
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
    const transaction: DbTransport["transaction"] = (f) =>
      Effect.suspend(() => {
        // Set before `COMMIT`. A transaction without an id wrote nothing.
        let xid: string | null | undefined;
        return runTransaction(
          f,
          (run) =>
            client.begin(async (tx) => {
              const value = await run(
                makeQuery(
                  drizzleBunSql({ client: tx }),
                  (cause) =>
                    hasCode(cause, NOT_APPLIED) ||
                    hasCode(cause, CONNECTION_LOST),
                ),
              );
              [{ xid }] =
                await tx`select pg_current_xact_id_if_assigned()::text as xid`;
              return value;
            }),
          (cause, value) => {
            // Postgres rolls back unless it ran `COMMIT`.
            if (xid === undefined) {
              return Effect.fail(
                new DbError({
                  sql: "select pg_current_xact_id_if_assigned()",
                  cause,
                  notApplied: true,
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
            if (xid === null) return Effect.succeed(value);
            // `COMMIT` may have run.
            return commitStatus(xid).pipe(
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
            );
          },
        );
      });

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

    return { query, transaction, lock };
  });
}

/**
 * PGlite's protocol reader decodes each field with a `TextDecoder` that strips
 * a leading U+FEFF. It builds the decoder in the constructor, so this one keeps
 * the BOM.
 */
function createPglite(): PGlite {
  const Decoder = globalThis.TextDecoder;
  globalThis.TextDecoder = class extends Decoder {
    constructor(...[label, options]: ConstructorParameters<typeof Decoder>) {
      super(label, { ...options, ignoreBOM: true });
    }
  };
  try {
    return new PGlite();
  } finally {
    globalThis.TextDecoder = Decoder;
  }
}

/** An in-memory PGlite database, until the scope closes. */
export function makePgliteTransport(): Effect.Effect<
  DbTransport,
  never,
  Scope.Scope
> {
  return Effect.gen(function* () {
    const client = yield* Effect.acquireRelease(
      Effect.promise(() => {
        const client = createPglite();
        return client.waitReady.then(() => client);
      }),
      (client) => Effect.promise(() => client.close()),
    );
    const db = drizzlePglite({ client });
    // PGlite has no connection to lose, so a retry would fail the same way.
    const notApplied = () => false;

    return {
      query: makeQuery(db, notApplied),
      transaction: (f) =>
        runTransaction(
          f,
          (run) => db.transaction((tx) => run(makeQuery(tx, notApplied))),
          (cause) => Effect.fail(new DbError({ sql: "COMMIT", cause })),
        ),
      // Only this process can reach an in-memory database.
      lock: () => Effect.succeed(Effect.never),
    };
  });
}
