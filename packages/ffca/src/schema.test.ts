import { expect, test } from "bun:test";
import { parseAbiParameters } from "abitype";
import {
  generateDrizzleJson,
  generateMigration,
} from "drizzle-kit/api-postgres";
import { drizzle } from "drizzle-orm/bun-sql/postgres";
import type { PgTable } from "drizzle-orm/pg-core";
import { TEST_DB_CONNECTION } from "../test/setup";
import { COUNTER_SIGNATURE_PARAMS } from "../test/utils";
import type { FFCAConfig } from "./config";
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
    signature: { params: COUNTER_SIGNATURE_PARAMS },
    mutations: {
      Transfer: {
        tag: 0,
        params: parseAbiParameters("address to, uint256 amount"),
      },
      Debit: {
        tag: 1,
        params: parseAbiParameters("bytes32 account, uint256 amount"),
        resolution: parseAbiParameters("uint256 newBalance"),
        resolve: () => ({ newBalance: 0n }),
      },
    },
  } satisfies Pick<FFCAConfig, "signature" | "mutations">);
  const statements = await applyGeneratedMigration(schema);
  const sql = statements.join("\n");

  expect(Object.keys(schema)).toEqual([
    "slot_writes",
    "known_paths",
    "transfer_mutations",
    "debit_mutations",
  ]);
  expect(sql).toContain('CREATE TABLE "slot_writes"');
  expect(sql).toContain('"id" serial PRIMARY KEY');
  expect(sql).toContain('"mutationId" integer NOT NULL');
  expect(sql).toContain('"slot" char(66) NOT NULL');
  expect(sql).toContain('"value" char(66) NOT NULL');
  expect(sql).toContain('CREATE INDEX "slot_writes_latest_idx"');
  expect(sql).toContain('CREATE TABLE "known_paths"');
  expect(sql).toContain('"path" text PRIMARY KEY');
  expect(sql).toContain('CREATE TYPE "mutation_status"');
  expect(sql).toContain('CREATE TABLE "transfer_mutations"');
  expect(sql).toContain('"executionIndex" numeric(78,0)');
  expect(sql).toContain('"status" "mutation_status" NOT NULL');
  expect(sql).toContain('"to" char(42) NOT NULL');
  expect(sql).toContain('"amount" numeric(78,0) NOT NULL');
  expect(sql).toContain('"signature_accountId" char(66) NOT NULL');
  expect(sql).toContain('"signature_publicKey" text NOT NULL');
  expect(sql).toContain('"signature_rawSignature" text NOT NULL');
  expect(sql).toContain('CREATE TABLE "debit_mutations"');
  expect(sql).toContain('"resolution_newBalance" numeric(78,0) NOT NULL');
});

test("mutation table supports insert and lifecycle update queries", async () => {
  const schema = createMutationSchema({
    signature: { params: COUNTER_SIGNATURE_PARAMS },
    mutations: {
      Transfer: {
        tag: 0,
        params: parseAbiParameters("address to, uint256 amount"),
      },
    },
  } satisfies Pick<FFCAConfig, "signature" | "mutations">);
  await applyGeneratedMigration(schema);
  const db = drizzle({ client: TEST_DB_CONNECTION });
  const transferMutations = requiredTable(schema, "transfer_mutations");
  const includedAt = new Date("2026-01-01T00:00:00.000Z");

  await db.insert(transferMutations).values({
    id: 1,
    status: "accepted",
    to: "0x0000000000000000000000000000000000000001",
    amount: 123n,
    signature_accountId:
      "0x1111111111111111111111111111111111111111111111111111111111111111",
    signature_publicKey: "0x1234",
    signature_rawSignature: "0xdeadbeef",
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
    signature_accountId:
      "0x1111111111111111111111111111111111111111111111111111111111111111",
    signature_publicKey: "0x1234",
    signature_rawSignature: "0xdeadbeef",
    blockNumber: 4n,
    blockTimestamp: 5n,
    transactionHash:
      "0x2222222222222222222222222222222222222222222222222222222222222222",
    includedAt,
  });
});

test("createMutationSchema exposes table names from config keys", () => {
  const schema = createMutationSchema({
    signature: { params: COUNTER_SIGNATURE_PARAMS },
    mutations: {
      Transfer: {
        tag: 0,
        params: parseAbiParameters("address to, uint256 amount"),
      },
      CancelOrder: {
        tag: 1,
        params: parseAbiParameters("bytes32 account"),
      },
    },
  } satisfies Pick<FFCAConfig, "signature" | "mutations">);

  const keys = ["transfer_mutations", "cancelorder_mutations"] satisfies Array<
    keyof typeof schema
  >;
  expect(keys).toEqual(["transfer_mutations", "cancelorder_mutations"]);
});
