import * as PgClient from "@effect/sql-pg/PgClient";
import * as PgDrizzle from "drizzle-orm/effect-postgres";
import { Context, Effect, Layer, Redacted } from "effect";

export type DatabaseOptions = {
  readonly url: string;
  readonly maxConnections?: number;
};

export type DatabaseClient = PgDrizzle.EffectPgDatabase & {
  readonly $client: PgClient.PgClient;
};

export class DatabaseConfig extends Context.Service<
  DatabaseConfig,
  DatabaseOptions
>()("ffca/DatabaseConfig") {}

export class Database extends Context.Service<Database, DatabaseClient>()(
  "ffca/Database",
) {}

function pgPoolConfig(config: DatabaseOptions): PgClient.PgPoolConfig {
  const base = { url: Redacted.make(config.url) };
  if (config.maxConnections === undefined) {
    return base;
  }
  return { ...base, maxConnections: config.maxConnections };
}

export const layerDatabase = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* DatabaseConfig;
    return Layer.effect(
      Database,
      PgDrizzle.makeWithDefaults().pipe(Effect.map((db) => Database.of(db))),
    ).pipe(Layer.provide(PgClient.layer(pgPoolConfig(config))));
  }),
);

export const layerDatabaseLive = (
  config: Context.Service.Shape<typeof DatabaseConfig>,
) => layerDatabase.pipe(Layer.provide(Layer.succeed(DatabaseConfig)(config)));
