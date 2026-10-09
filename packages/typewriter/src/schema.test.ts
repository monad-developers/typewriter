import { expect, expectTypeOf, test } from "bun:test";
import { parseAbiParameters } from "abitype";
import {
  generateDrizzleJson,
  generateMigration,
} from "drizzle-kit/api-postgres";
import { drizzle } from "drizzle-orm/bun-sql/postgres";
import type { PgTable } from "drizzle-orm/pg-core";
import { TEST_DB_CONNECTION } from "../test/setup";
import { updateSchema } from "./migrate";
import { createMutationSchema, mutationStatusEnum } from "./schema";

async function applyGeneratedMigration(
  schema: Record<string, unknown>,
): Promise<string[]> {
  updateSchema(schema as Record<string, PgTable>, "public");
  const empty = await generateDrizzleJson({});
  const target = await generateDrizzleJson({ mutationStatusEnum, ...schema });
  const statements = await generateMigration(empty, target);
  for (const statement of statements) {
    await TEST_DB_CONNECTION.unsafe(statement);
  }
  return statements;
}

function requiredTable<
  Schema extends Record<string, unknown>,
  Name extends keyof Schema,
>(schema: Schema, name: Name): Schema[Name] {
  const table = schema[name];
  if (table === undefined) {
    throw new Error(`table missing: ${String(name)}`);
  }
  return table;
}

test("createMutationSchema creates lowercased flat mutation tables", async () => {
  const schema = createMutationSchema({
    mutations: {
      Transfer: {
        id: 0,
        params: parseAbiParameters("address to, uint256 amount"),
      },
      Debit: {
        id: 1,
        params: parseAbiParameters("bytes32 account, uint256 amount"),
      },
    },
  });
  const statements = await applyGeneratedMigration(schema);
  const sql = statements.join("\n");

  expect(Object.keys(schema)).toEqual([
    "slot_writes",
    "keccak_preimages",
    "transfer_mutations",
    "debit_mutations",
  ]);
  expect(sql).toContain('CREATE TABLE "slot_writes"');
  expect(sql).toContain('"id" serial PRIMARY KEY');
  expect(sql).toContain('"mutationId" integer NOT NULL');
  expect(sql).toContain('"slot" char(66) NOT NULL');
  expect(sql).toContain('"value" char(66) NOT NULL');
  expect(sql).toContain('CREATE INDEX "slot_writes_latest_idx"');
  expect(sql).toContain('CREATE TABLE "keccak_preimages"');
  expect(sql).toContain('"preimage" char(130) PRIMARY KEY');
  expect(sql).toContain('CREATE TYPE "mutation_status"');
  expect(sql).toContain('CREATE TABLE "transfer_mutations"');
  expect(sql).toContain('"executionIndex" numeric(78,0)');
  expect(sql).toContain('"status" "mutation_status" NOT NULL');
  expect(sql).toContain('"to" char(42) NOT NULL');
  expect(sql).toContain('"amount" numeric(78,0) NOT NULL');
  expect(sql).toContain('"authorization_account_id" char(66) NOT NULL');
  expect(sql).toContain('"authorization_credential_id" numeric(20,0) NOT NULL');
  expect(sql).toContain('"authorization_nonce" numeric(78,0) NOT NULL');
  expect(sql).toContain('"authorization_expiration" numeric(78,0) NOT NULL');
  expect(sql).toContain('"authorization_signature" text NOT NULL');
  expect(sql).toContain('CREATE TABLE "debit_mutations"');
  expect(sql).not.toContain('"resolution_');
});

test("mutation table supports insert and lifecycle update queries", async () => {
  const schema = createMutationSchema({
    mutations: {
      Transfer: {
        id: 0,
        params: parseAbiParameters("address to, uint256 amount"),
      },
    },
  });
  await applyGeneratedMigration(schema);
  const db = drizzle({ client: TEST_DB_CONNECTION });
  const transferMutations = requiredTable(schema, "transfer_mutations");
  const includedAt = new Date("2026-01-01T00:00:00.000Z");

  await db.insert(transferMutations).values({
    id: 1,
    status: "accepted",
    to: "0x0000000000000000000000000000000000000001",
    amount: 123n,
    authorization_account_id:
      "0x1111111111111111111111111111111111111111111111111111111111111111",
    authorization_credential_id: 7n,
    authorization_nonce: 11n,
    authorization_expiration: 1_900_000_000n,
    authorization_signature: "0xdeadbeef",
  });

  await db.update(transferMutations).set({
    status: "included",
    blockNumber: 4n,
    blockHash:
      "0x1111111111111111111111111111111111111111111111111111111111111111",
    blockTimestamp: 5n,
    transactionHash:
      "0x2222222222222222222222222222222222222222222222222222222222222222",
    includedAt,
  });

  const [row] = await db.select().from(transferMutations);

  expect(row).toMatchObject({
    id: 1,
    status: "included",
    to: "0x0000000000000000000000000000000000000001",
    amount: 123n,
    authorization_account_id:
      "0x1111111111111111111111111111111111111111111111111111111111111111",
    authorization_credential_id: 7n,
    authorization_nonce: 11n,
    authorization_expiration: 1_900_000_000n,
    authorization_signature: "0xdeadbeef",
    blockNumber: 4n,
    blockTimestamp: 5n,
    transactionHash:
      "0x2222222222222222222222222222222222222222222222222222222222222222",
    includedAt,
  });
});

test("createMutationSchema exposes table names from config keys", () => {
  const schema = createMutationSchema({
    mutations: {
      Transfer: {
        id: 0,
        params: parseAbiParameters("address to, uint256 amount"),
      },
      CancelOrder: {
        id: 1,
        params: parseAbiParameters("bytes32 account"),
      },
    },
  });

  const keys = ["transfer_mutations", "cancelorder_mutations"] satisfies Array<
    keyof typeof schema
  >;
  expect(keys).toEqual(["transfer_mutations", "cancelorder_mutations"]);
});

test("createMutationSchema preserves generated column types", () => {
  const schema = createMutationSchema({
    mutations: {
      Transfer: {
        id: 0,
        params: parseAbiParameters("address to, uint256 amount"),
      },
      Debit: {
        id: 1,
        params: parseAbiParameters("bytes32 account, uint256 amount"),
      },
    },
  });

  expectTypeOf<typeof schema.transfer_mutations.$inferInsert>().toExtend<{
    id: number;
    status: "accepted" | "included" | "safe" | "finalized";
    to: `0x${string}`;
    amount: bigint;
    authorization_account_id: `0x${string}`;
    authorization_credential_id: bigint;
    authorization_nonce: bigint;
    authorization_expiration: bigint;
    authorization_signature: `0x${string}`;
  }>();
  expectTypeOf<typeof schema.debit_mutations.$inferInsert>().toExtend<{
    account: `0x${string}`;
    amount: bigint;
  }>();
  expectTypeOf<typeof schema.slot_writes.$inferInsert>().toExtend<{
    mutationId: number;
    slot: `0x${string}`;
    value: `0x${string}`;
  }>();
});
