import { Context, Effect, Layer, Schedule, type Scope } from "effect";
import {
  type CompiledStatement,
  compile,
  DbError,
  type DbStatement,
  type DbTransport,
  makePostgresTransport,
  type PostgresOptions,
} from "./db-transport";

export type DatabaseOptions = PostgresOptions;

type Statement = DbStatement<unknown> | CompiledStatement;

type Result<statement> =
  statement extends DbStatement<infer result> ? result : unknown;

export type Db = {
  /**
   * Runs one statement, or a list in one transaction, in order. The statements
   * are compiled when `run` is called, so a retry sends the same ones.
   */
  run: {
    <const statement extends Statement>(
      statement: statement,
    ): Effect.Effect<Result<statement>, DbError>;
    <const statements extends readonly Statement[]>(
      statements: statements,
    ): Effect.Effect<
      { -readonly [K in keyof statements]: Result<statements[K]> },
      DbError
    >;
  };
  lock: DbTransport["lock"];
};

export class Database extends Context.Service<Database, Db>()(
  "typewriter/Database",
) {}

export const layerDatabase = (
  options: DatabaseOptions,
): Layer.Layer<Database> => Layer.effect(Database, makeDb(options));

function retry<a, e, r>(effect: Effect.Effect<a, e, r>) {
  return effect.pipe(
    // A failure that stops the runtime is logged when it stops, so an attempt
    // is only a debug log.
    Effect.tapError((error) => Effect.logDebug("Failed database query", error)),
    Effect.retry({
      schedule: Schedule.exponential("10 millis").pipe(Schedule.jittered),
      times: 4,
      while: (error) => error instanceof DbError && error.notApplied === true,
    }),
  );
}

/** Retries the work of `transport` that did not apply. */
export function makeDbClient(transport: DbTransport): Db {
  const run = (statements: Statement | readonly Statement[]) => {
    const list: readonly Statement[] = Array.isArray(statements)
      ? statements
      : [statements];
    const compiled = list.map((statement) =>
      "getSQL" in statement ? compile(statement) : statement,
    );
    return retry(transport.run(compiled)).pipe(
      Effect.map((results) =>
        Array.isArray(statements) ? results : results[0],
      ),
    );
  };

  return { run: run as Db["run"], lock: transport.lock };
}

export function makeDb(
  options: DatabaseOptions,
): Effect.Effect<Db, never, Scope.Scope> {
  return Effect.map(makePostgresTransport(options), makeDbClient);
}
