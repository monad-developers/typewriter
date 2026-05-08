import { expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sql";
import type { Address } from "ox";
import { TEST_DB_CONNECTION } from "../test/setup";
import { HARNESS_SCHEMA } from "../test/utils";
import { migrate, updateSchema } from "./migrate";

test("migrate creates the configured schema", async () => {
  const chainId = 31337;
  const address =
    "0x000000000000000000000000000000000000ffca" as Address.Address;
  const testSchema = "ffca_31337_0x000000000000000000000000000000000000ffca";

  const db = drizzle(TEST_DB_CONNECTION, {
    schema: HARNESS_SCHEMA,
    casing: "snake_case",
  });
  const schemaName = await migrate(db, chainId, address);
  updateSchema(HARNESS_SCHEMA, schemaName);

  const tables = await TEST_DB_CONNECTION<{ table_name: string }[]>`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = ${schemaName}
      ORDER BY table_name
    `;
  const enums = await TEST_DB_CONNECTION<
    { enum_name: string; values: string[] }[]
  >`
      SELECT pg_type.typname AS enum_name, array_agg(pg_enum.enumlabel ORDER BY pg_enum.enumsortorder) AS values
      FROM pg_type
      JOIN pg_namespace ON pg_namespace.oid = pg_type.typnamespace
      JOIN pg_enum ON pg_enum.enumtypid = pg_type.oid
      WHERE pg_namespace.nspname = ${schemaName}
      GROUP BY pg_type.typname
      ORDER BY pg_type.typname
    `;

  expect(schemaName).toBe(testSchema);
  expect(tables.map((row) => row.table_name)).toEqual([
    "accounts",
    "balances",
    "harness_asserts",
    "harness_authorizes",
    "harness_credits",
    "harness_debits",
    "harness_initializes",
    "keys",
    "nonces",
  ]);
  expect(enums).toEqual([
    {
      enum_name: "mutation_status",
      values: ["accepted", "proposed", "voted", "finalized", "verified"],
    },
  ]);

  await db.insert(HARNESS_SCHEMA.accounts).values({
    id: "0x0000000000000000000000000000000000000000000000000000000000000001",
  });
  const accounts = await db
    .select()
    .from(HARNESS_SCHEMA.accounts)
    .where(
      eq(
        HARNESS_SCHEMA.accounts.id,
        "0x0000000000000000000000000000000000000000000000000000000000000001",
      ),
    );
  expect(accounts).toEqual([
    {
      id: "0x0000000000000000000000000000000000000000000000000000000000000001",
    },
  ]);
});

test("migrate is idempotent when schema already exists", async () => {
  const chainId = 31338;
  const address =
    "0x000000000000000000000000000000000000ffca" as Address.Address;
  const testSchema = "ffca_31338_0x000000000000000000000000000000000000ffca";

  const db = drizzle(TEST_DB_CONNECTION, {
    schema: HARNESS_SCHEMA,
    casing: "snake_case",
  });
  const firstSchemaName = await migrate(db, chainId, address);
  const secondSchemaName = await migrate(db, chainId, address);

  const tables = await TEST_DB_CONNECTION<{ table_name: string }[]>`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = ${testSchema}
      ORDER BY table_name
    `;

  expect(firstSchemaName).toBe(testSchema);
  expect(secondSchemaName).toBe(testSchema);
  expect(tables.map((row) => row.table_name)).toEqual([
    "accounts",
    "balances",
    "harness_asserts",
    "harness_authorizes",
    "harness_credits",
    "harness_debits",
    "harness_initializes",
    "keys",
    "nonces",
  ]);
});
