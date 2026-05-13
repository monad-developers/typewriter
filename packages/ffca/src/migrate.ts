import {
  type DrizzleSnapshotJSON,
  generateDrizzleJson,
  generateMigration,
} from "drizzle-kit/api";
import { sql } from "drizzle-orm";
import type { BunSQLDatabase } from "drizzle-orm/bun-sql";
import type { BunSQLTransaction } from "drizzle-orm/bun-sql/session";
import type { PgEnum } from "drizzle-orm/pg-core";
import { isPgEnum } from "drizzle-orm/pg-core";
import type { PgTable } from "drizzle-orm/pg-core/table";
import { isTable } from "drizzle-orm/table";
import type { Address } from "ox";
import { mutationStatusEnum } from "./schema";

export type FFCAMigrateDatabase = BunSQLDatabase<Record<string, unknown>>;
const schemaSymbol = Symbol.for("drizzle:Schema");

type SchemaMutable = Record<typeof schemaSymbol, string | undefined>;
type PgEnumMutable = PgEnum<[string, ...string[]]> & {
  schema: string | undefined;
};

export function updateSchema<TSchema extends Record<string, unknown>>(
  schema: TSchema,
  schemaName: string,
): TSchema {
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

  return schema;
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
  return BigInt.asIntN(64, BigInt(Bun.hash.wyhash(schemaName)));
}

export function deploymentLockKey(
  chainId: number,
  address: Address.Address,
): bigint {
  return lockKey(deploymentSchemaName(chainId, address));
}

async function doesSchemaExist(
  tx: BunSQLTransaction<Record<string, unknown>, Record<string, never>>,
  schemaName: string,
): Promise<boolean> {
  const [{ exists = false } = { exists: false }] = await tx.execute<{
    exists: boolean;
  }>(sql`
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
  `);
  return exists;
}

function quoteIdentifier(identifier: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(identifier)) {
    throw new Error(`Invalid SQL identifier: ${identifier}`);
  }
  return `"${identifier}"`;
}

async function findAcceptedMutationTable(
  tx: BunSQLTransaction<Record<string, unknown>, Record<string, never>>,
  schemaName: string,
): Promise<string | undefined> {
  const tables = await tx.execute<{ table_name: string }>(sql`
    SELECT table_name
    FROM information_schema.columns
    WHERE table_schema = ${schemaName}
      AND column_name = 'status'
      AND udt_schema = ${schemaName}
      AND udt_name = 'mutation_status'
    ORDER BY table_name
  `);

  for (const { table_name: tableName } of tables) {
    const [{ exists = false } = { exists: false }] = await tx.execute<{
      exists: boolean;
    }>(
      sql.raw(
        `SELECT EXISTS (SELECT 1 FROM ${quoteIdentifier(schemaName)}.${quoteIdentifier(tableName)} WHERE status = 'accepted') AS exists`,
      ),
    );
    if (exists) return tableName;
  }

  return undefined;
}

export async function migrate(
  db: FFCAMigrateDatabase,
  chainId: number,
  address: Address.Address,
): Promise<string> {
  const schemaName = deploymentSchemaName(chainId, address);
  const targetSchema = {
    mutationStatusEnum,
    ...updateSchema(db._.fullSchema, schemaName),
  };
  const empty: DrizzleSnapshotJSON = generateDrizzleJson(
    {},
    undefined,
    undefined,
    "snake_case",
  );
  const target: DrizzleSnapshotJSON = generateDrizzleJson(
    targetSchema,
    undefined,
    undefined,
    "snake_case",
  );
  const statements = await generateMigration(empty, target);

  await db.transaction(async (tx) => {
    await tx.execute(sql.raw("SET LOCAL lock_timeout = '60s'"));
    await tx.execute(sql.raw(`CREATE SCHEMA IF NOT EXISTS ${schemaName}`));

    const exists = await doesSchemaExist(tx, schemaName);

    if (exists === false) {
      for (const statement of statements) {
        await tx.execute(sql.raw(statement));
      }
      return;
    }

    // TODO: Track the generated schema as deployment metadata and compare it
    // here before deciding whether an existing schema is safe to reuse.

    const acceptedMutationTable = await findAcceptedMutationTable(
      tx,
      schemaName,
    );
    if (acceptedMutationTable !== undefined) {
      throw new Error(
        `FFCA deployment schema contains accepted mutations and cannot be recovered yet: ${schemaName}.${acceptedMutationTable}`,
      );
    }
  });

  return schemaName;
}
