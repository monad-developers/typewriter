import { Context, Effect, Layer, Schedule, type Scope } from "effect";
import {
  DbError,
  type DbTransport,
  makePostgresTransport,
  type PostgresOptions,
} from "./db-transport";

export type DatabaseOptions = PostgresOptions;

/** Retries run a transaction again from the start, so `f` can run more than once. */
export type Db = DbTransport;

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
function makeDbClient(transport: DbTransport): Db {
  return {
    query: (build) => retry(transport.query(build)),
    transaction: (f) => retry(transport.transaction(f)),
    lock: transport.lock,
  };
}

export function makeDb(
  options: DatabaseOptions,
): Effect.Effect<Db, never, Scope.Scope> {
  return Effect.map(makePostgresTransport(options), makeDbClient);
}
