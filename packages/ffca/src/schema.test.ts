import { expect, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { parseAbiParameters } from "abitype";
import {
  generateDrizzleJson,
  generateMigration,
} from "drizzle-kit/api-postgres";
import { integer, pgTable } from "drizzle-orm/pg-core";
import { drizzle } from "drizzle-orm/pglite";
import { STUB_FFCA_ABI } from "../test/utils";
import type { FFCAConfig } from "./config";
import { updateSchema } from "./migrate";
import {
  createMutationSchema,
  type GeneratedMutationSchema,
  mutationStatusEnum,
} from "./schema";

const unusedTable = pgTable("unused_mutation_config_table", {
  id: integer().primaryKey(),
});

async function applyGeneratedMigration(
  client: PGlite,
  schema: Record<string, unknown>,
): Promise<string[]> {
  updateSchema(schema as never, "public");
  const empty = await generateDrizzleJson({});
  const target = await generateDrizzleJson({ mutationStatusEnum, ...schema });
  const statements = await generateMigration(empty, target);
  for (const statement of statements) {
    await client.exec(statement);
  }
  return statements;
}

function requiredTable<
  Schema extends Record<string, unknown>,
  Name extends keyof Schema,
>(schema: Schema, name: Name): Schema[Name] {
  const table = schema[name];
  if (table === undefined) {
    throw new Error(`generated table missing: ${String(name)}`);
  }
  return table;
}

test("createMutationSchema creates lowercased flat mutation tables", async () => {
  const schema = createMutationSchema({
    abi: STUB_FFCA_ABI,
    mutations: {
      Transfer: {
        tag: 0,
        table: unusedTable,
        params: parseAbiParameters("address to, uint256 amount"),
      },
      Debit: {
        tag: 1,
        table: unusedTable,
        params: parseAbiParameters("bytes32 account, uint256 amount"),
        resolution: parseAbiParameters("uint256 newBalance"),
        resolve: () => ({ newBalance: 0n }),
      },
    },
  } satisfies Pick<FFCAConfig, "abi" | "mutations">);
  const statements = await applyGeneratedMigration(new PGlite(), schema);
  const sql = statements.join("\n");

  expect(Object.keys(schema)).toEqual([
    "transfer_mutations",
    "debit_mutations",
  ]);
  expect(sql).toContain('CREATE TYPE "mutation_status"');
  expect(sql).toContain('CREATE TABLE "transfer_mutations"');
  expect(sql).toContain('"status" "mutation_status" NOT NULL');
  expect(sql).toContain('"to" char(42) NOT NULL');
  expect(sql).toContain('"amount" numeric(78,0) NOT NULL');
  expect(sql).toContain('"signature_keyType" smallint NOT NULL');
  expect(sql).toContain('"signature_rawSignature" text NOT NULL');
  expect(sql).toContain('CREATE TABLE "debit_mutations"');
  expect(sql).toContain('"resolution_newBalance" numeric(78,0) NOT NULL');
});

test("generated mutation table supports insert and lifecycle update queries", async () => {
  const schema = createMutationSchema({
    abi: STUB_FFCA_ABI,
    mutations: {
      Transfer: {
        tag: 0,
        table: unusedTable,
        params: parseAbiParameters("address to, uint256 amount"),
      },
    },
  } satisfies Pick<FFCAConfig, "abi" | "mutations">);
  const client = new PGlite();
  await applyGeneratedMigration(client, schema);
  const db = drizzle({ client });
  const transferMutations = requiredTable(schema, "transfer_mutations");
  const includedAt = new Date("2026-01-01T00:00:00.000Z");

  await db.insert(transferMutations).values({
    id: 1,
    bundleId: 2,
    bundlePosition: 3,
    status: "accepted",
    to: "0x0000000000000000000000000000000000000001",
    amount: "123",
    signature_keyType: 0,
    signature_rawSignature: "0xdeadbeef",
  });

  await db.update(transferMutations).set({
    status: "included",
    blockNumber: "4",
    blockHash:
      "0x1111111111111111111111111111111111111111111111111111111111111111",
    blockTimestamp: "5",
    transactionHash:
      "0x2222222222222222222222222222222222222222222222222222222222222222",
    includedAt,
  });

  const [row] = await db.select().from(transferMutations);

  expect(row).toMatchObject({
    id: 1,
    bundleId: 2,
    bundlePosition: 3,
    status: "included",
    to: "0x0000000000000000000000000000000000000001",
    amount: "123",
    signature_keyType: 0,
    signature_rawSignature: "0xdeadbeef",
    blockNumber: "4",
    blockTimestamp: "5",
    transactionHash:
      "0x2222222222222222222222222222222222222222222222222222222222222222",
    includedAt,
  });
});

test("GeneratedMutationSchema exposes table names from config keys", () => {
  type Schema = GeneratedMutationSchema<
    FFCAConfig & {
      mutations: {
        Transfer: FFCAConfig["mutations"][string];
        CancelOrder: FFCAConfig["mutations"][string];
      };
    }
  >;

  const keys = ["transfer_mutations", "cancelorder_mutations"] satisfies Array<
    keyof Schema
  >;
  expect(keys).toEqual(["transfer_mutations", "cancelorder_mutations"]);
});
