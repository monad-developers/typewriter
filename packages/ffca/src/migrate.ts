import {
  generateDrizzleJson,
  generateMigration,
} from "drizzle-kit/api-postgres";
import type { PgEnum } from "drizzle-orm/pg-core";
import { isPgEnum } from "drizzle-orm/pg-core";
import type { PgTable } from "drizzle-orm/pg-core/table";
import { isTable } from "drizzle-orm/table";
import { Data, Effect } from "effect";
import type { SqlError } from "effect/unstable/sql/SqlError";
import type { Address } from "ox";
import { Database, type DatabaseClient } from "./db";
import { mutationStatusEnum } from "./schema";

const schemaSymbol = Symbol.for("drizzle:Schema");

export class MigrationError extends Data.TaggedError("MigrationError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

type SchemaMutable = Record<typeof schemaSymbol, string | undefined>;
type PgEnumMutable = PgEnum<[string, ...string[]]> & {
  schema: string | undefined;
};

export function updateSchema(
  schema: Record<string, PgTable>,
  schemaName: string,
): void {
  const updateValue = (value: unknown) => {
    if (isTable(value)) {
      (value as PgTable & SchemaMutable)[schemaSymbol] = schemaName;
      return;
    }
    if (isPgEnum(value)) {
      (value as PgEnumMutable).schema = schemaName;
    }
  };

  updateValue(mutationStatusEnum);
  for (const value of Object.values(schema)) {
    updateValue(value);
  }
}

export function deploymentSchemaName(
  chainId: number,
  address: Address.Address,
): string {
  if (!Number.isSafeInteger(chainId) || chainId < 0) {
    throw new Error(`Invalid chain id: ${chainId}`);
  }
  return `ffca_${chainId}_${address.toLowerCase()}`;
}

function lockKey(schemaName: string): bigint {
  let hash = 0xcbf29ce484222325n;
  for (let i = 0; i < schemaName.length; i++) {
    hash ^= BigInt(schemaName.charCodeAt(i));
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return BigInt.asIntN(64, hash);
}

export function deploymentLockKey(
  chainId: number,
  address: Address.Address,
): bigint {
  return lockKey(deploymentSchemaName(chainId, address));
}

function doesSchemaExist(
  db: DatabaseClient,
  schemaName: string,
): Effect.Effect<boolean, SqlError> {
  return Effect.gen(function* () {
    const sql = db.$client;
    const [{ exists = false } = { exists: false }] = yield* sql<{
      exists: boolean;
    }>`
    SELECT EXISTS (
      SELECT 1
      FROM information_schema.tables
      WHERE table_schema = ${schemaName}
      UNION ALL
      SELECT 1
      FROM pg_type
      JOIN pg_namespace ON pg_namespace.oid = pg_type.typnamespace
      WHERE pg_namespace.nspname = ${schemaName}
      LIMIT 1
    ) AS exists
  `;
    return exists;
  });
}

function findAcceptedMutationTable(
  db: DatabaseClient,
  schemaName: string,
): Effect.Effect<string | undefined, MigrationError | SqlError> {
  return Effect.gen(function* () {
    const sql = db.$client;
    const tables = yield* sql<{ table_name: string }>`
    SELECT table_name
    FROM information_schema.columns
    WHERE table_schema = ${schemaName}
      AND column_name = 'status'
      AND udt_schema = ${schemaName}
      AND udt_name = 'mutation_status'
    ORDER BY table_name
  `;

    for (const { table_name: tableName } of tables) {
      const [{ exists = false } = { exists: false }] = yield* sql<{
        exists: boolean;
      }>`
          SELECT EXISTS (
            SELECT 1
            FROM ${sql(schemaName)}.${sql(tableName)}
            WHERE status = 'accepted'
          ) AS exists
        `;
      if (exists) return tableName;
    }

    return undefined;
  });
}

export function migrate(
  schema: Record<string, unknown>,
  chainId: number,
  address: Address.Address,
): Effect.Effect<string, MigrationError | SqlError, Database> {
  return Effect.gen(function* () {
    const db = yield* Database;
    const sql = db.$client;
    const schemaName = yield* Effect.try({
      try: () => deploymentSchemaName(chainId, address),
      catch: (cause) =>
        new MigrationError({
          message: "Invalid FFCA deployment schema config",
          cause,
        }),
    });
    updateSchema(schema as Record<string, PgTable>, schemaName);
    const targetSchema = {
      mutationStatusEnum,
      ...schema,
    };
    const empty = yield* Effect.tryPromise({
      try: () => generateDrizzleJson({}),
      catch: (cause) =>
        new MigrationError({
          message: "Failed to generate empty Drizzle schema snapshot",
          cause,
        }),
    });
    const target = yield* Effect.tryPromise({
      try: () => generateDrizzleJson(targetSchema),
      catch: (cause) =>
        new MigrationError({
          message: "Failed to generate target Drizzle schema snapshot",
          cause,
        }),
    });
    const statements = yield* Effect.tryPromise({
      try: () => generateMigration(empty, target),
      catch: (cause) =>
        new MigrationError({
          message: "Failed to generate Drizzle migration statements",
          cause,
        }),
    });

    yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* sql.unsafe("SET LOCAL lock_timeout = '60s'");
        yield* sql`
          CREATE SCHEMA IF NOT EXISTS ${sql(schemaName)}
        `;

        const exists = yield* doesSchemaExist(db, schemaName);

        if (exists === false) {
          for (const statement of statements) {
            yield* sql.unsafe(statement);
          }
          return;
        }

        // TODO: Track the generated schema as deployment metadata and compare it
        // here before deciding whether an existing schema is safe to reuse.

        const acceptedMutationTable = yield* findAcceptedMutationTable(
          db,
          schemaName,
        );
        if (acceptedMutationTable !== undefined) {
          return yield* new MigrationError({
            message: `FFCA deployment schema contains accepted mutations and cannot be recovered yet: ${schemaName}.${acceptedMutationTable}`,
          });
        }
      }),
    );

    return schemaName;
  });
}
