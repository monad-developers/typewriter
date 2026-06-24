import { expect, test } from "bun:test";
import { parseAbiParameters } from "abitype";
import {
  generateDrizzleJson,
  generateMigration,
} from "drizzle-kit/api-postgres";
import { drizzle } from "drizzle-orm/bun-sql/postgres";
import type { PgTable } from "drizzle-orm/pg-core";
import { Effect } from "effect";
import type { Address } from "ox";
import { TEST_DB_CONNECTION, TEST_DB_URL } from "../test/setup";
import { COUNTER_SIGNATURE_PARAMS } from "../test/utils";
import type { ResolvedFFCAMutationConfig } from "./config";
import { Database, layerDatabaseLive } from "./db";
import {
  insertKnownPaths,
  insertMutation,
  insertSlotWrites,
  selectAccountStorage,
  selectKnownPaths,
  selectNextMutationId,
  updateMutationLifecycle,
} from "./db-query";
import { deploymentSchemaName, migrate, updateSchema } from "./migrate";
import { createMutationSchema, mutationStatusEnum } from "./schema";
import type { RuntimeBlock, RuntimeMutation } from "./types";

const transferConfig = {
  tag: 0,
  params: parseAbiParameters("address to, uint256 amount"),
} satisfies ResolvedFFCAMutationConfig;

const debitConfig = {
  tag: 1,
  params: parseAbiParameters("bytes32 account, uint256 amount"),
} satisfies ResolvedFFCAMutationConfig;

const testSignature = {
  accountId:
    "0x1111111111111111111111111111111111111111111111111111111111111111",
  publicKey: "0x1234",
  rawSignature: "0xdeadbeef",
} as const;

async function applyGeneratedMigration(
  schema: Record<string, unknown>,
): Promise<void> {
  updateSchema(schema as Record<string, PgTable>, "public");
  const empty = await generateDrizzleJson({});
  const target = await generateDrizzleJson({ mutationStatusEnum, ...schema });
  const statements = await generateMigration(empty, target);
  for (const statement of statements) {
    await TEST_DB_CONNECTION.unsafe(statement);
  }
}

function runWithDatabase<R, E>(effect: Effect.Effect<R, E, Database>) {
  return Effect.runPromise(
    effect.pipe(
      Effect.provide(
        layerDatabaseLive({ url: TEST_DB_URL, maxConnections: 1 }),
      ),
    ),
  );
}

function requiredTable<
  Schema extends Record<string, unknown>,
  Name extends keyof Schema,
>(schema: Schema, name: Name): Exclude<Schema[Name], undefined> {
  const table = schema[name];
  if (table === undefined) {
    throw new Error(`table missing: ${String(name)}`);
  }
  return table as Exclude<Schema[Name], undefined>;
}

test("insertMutation inserts a mutation row", async () => {
  const schema = createMutationSchema({
    signature: { params: COUNTER_SIGNATURE_PARAMS },
    mutations: { Debit: debitConfig },
  });
  await applyGeneratedMigration(schema);

  const mutation = {
    status: "accepted",
    id: 1,
    name: "Debit",
    params: {
      account:
        "0x1111111111111111111111111111111111111111111111111111111111111111",
      amount: 123n,
    },
    signature: testSignature,
    journalId: 1,
    isForceInclusion: false,
    config: debitConfig,
  } satisfies Extract<
    RuntimeMutation,
    { status: "accepted" | "included" | "safe" | "finalized" }
  >;

  await runWithDatabase(
    Effect.gen(function* () {
      const db = yield* Database;
      yield* db.transaction((tx) => insertMutation(tx, schema, mutation));
    }),
  );

  const db = drizzle({ client: TEST_DB_CONNECTION });
  const [row] = await db
    .select()
    .from(requiredTable(schema, "debit_mutations"));

  expect(row).toMatchObject({
    id: 1,
    status: "accepted",
    account:
      "0x1111111111111111111111111111111111111111111111111111111111111111",
    amount: 123n,
    signature_accountId: testSignature.accountId,
    signature_publicKey: testSignature.publicKey,
    signature_rawSignature: testSignature.rawSignature,
  });
});

test("updateMutationLifecycle updates lifecycle columns", async () => {
  const schema = createMutationSchema({
    signature: { params: COUNTER_SIGNATURE_PARAMS },
    mutations: { Transfer: transferConfig },
  });
  await applyGeneratedMigration(schema);

  const mutation = {
    status: "accepted",
    id: 2,
    name: "Transfer",
    params: {
      to: "0x0000000000000000000000000000000000000001",
      amount: 456n,
    },
    signature: { ...testSignature, rawSignature: "0xfeed" },
    journalId: 2,
    isForceInclusion: false,
    config: transferConfig,
  } satisfies Extract<
    RuntimeMutation,
    { status: "accepted" | "included" | "safe" | "finalized" }
  >;
  const block = {
    status: "included",
    number: 4n,
    hash: "0x1111111111111111111111111111111111111111111111111111111111111111",
    timestamp: 5n,
    transactionHash:
      "0x2222222222222222222222222222222222222222222222222222222222222222",
    mutations: [{ ...mutation, status: "included" }],
  } satisfies RuntimeBlock<"fifo">;

  await runWithDatabase(
    Effect.gen(function* () {
      const db = yield* Database;
      yield* db.transaction((tx) => insertMutation(tx, schema, mutation));
      yield* db.transaction((tx) =>
        updateMutationLifecycle(
          tx,
          schema,
          {
            ...mutation,
            status: "included",
          },
          block,
        ),
      );
    }),
  );

  const db = drizzle({ client: TEST_DB_CONNECTION });
  const [row] = await db
    .select()
    .from(requiredTable(schema, "transfer_mutations"));
  const includedAt = (row as { includedAt?: unknown } | undefined)?.includedAt;

  expect(row).toMatchObject({
    id: 2,
    status: "included",
    to: "0x0000000000000000000000000000000000000001",
    amount: 456n,
    signature_accountId: testSignature.accountId,
    signature_publicKey: testSignature.publicKey,
    signature_rawSignature: "0xfeed",
  });
  expect(includedAt).toBeInstanceOf(Date);
});

test("selectNextMutationId resumes after the max id across mutation tables", async () => {
  const schema = createMutationSchema({
    signature: { params: COUNTER_SIGNATURE_PARAMS },
    mutations: { Debit: debitConfig, Transfer: transferConfig },
  });
  await applyGeneratedMigration(schema);

  await TEST_DB_CONNECTION`
    INSERT INTO transfer_mutations
      (id, status, ${TEST_DB_CONNECTION("to")}, amount, ${TEST_DB_CONNECTION("signature_accountId")}, ${TEST_DB_CONNECTION("signature_publicKey")}, ${TEST_DB_CONNECTION("signature_rawSignature")})
    VALUES
      (2, 'included', '0x0000000000000000000000000000000000000001', 1, '0x0000000000000000000000000000000000000000000000000000000000000000', '0x', '0x')
  `;
  await TEST_DB_CONNECTION`
    INSERT INTO debit_mutations
      (id, status, account, amount, ${TEST_DB_CONNECTION("signature_accountId")}, ${TEST_DB_CONNECTION("signature_publicKey")}, ${TEST_DB_CONNECTION("signature_rawSignature")})
    VALUES
      (7, 'included', '0x1111111111111111111111111111111111111111111111111111111111111111', 1, '0x0000000000000000000000000000000000000000000000000000000000000000', '0x', '0x')
  `;

  const nextId = await runWithDatabase(selectNextMutationId(schema));

  expect(nextId).toBe(8);
});

test("insertSlotWrites records raw slot writes", async () => {
  const schema = createMutationSchema({
    signature: { params: COUNTER_SIGNATURE_PARAMS },
    mutations: { Transfer: transferConfig },
  });
  await applyGeneratedMigration(schema);

  await runWithDatabase(
    Effect.gen(function* () {
      const db = yield* Database;
      yield* db.transaction((tx) =>
        insertSlotWrites(tx, schema, { id: 42 }, [
          {
            address: "0x000000000000000000000000000000000000typewriter",
            slot: "0x0000000000000000000000000000000000000000000000000000000000000001",
            prev_value:
              "0x0000000000000000000000000000000000000000000000000000000000000000",
            new_value:
              "0x000000000000000000000000000000000000000000000000000000000000000a",
          },
          {
            address: "0x000000000000000000000000000000000000typewriter",
            slot: "0x0000000000000000000000000000000000000000000000000000000000000002",
            prev_value:
              "0x0000000000000000000000000000000000000000000000000000000000000000",
            new_value:
              "0x000000000000000000000000000000000000000000000000000000000000000b",
          },
        ]),
      );
    }),
  );

  const db = drizzle({ client: TEST_DB_CONNECTION });
  const rows = await db.select().from(requiredTable(schema, "slot_writes"));
  expect(rows).toMatchObject([
    {
      id: 1,
      mutationId: 42,
      slot: "0x0000000000000000000000000000000000000000000000000000000000000001",
      value:
        "0x000000000000000000000000000000000000000000000000000000000000000a",
    },
    {
      id: 2,
      mutationId: 42,
      slot: "0x0000000000000000000000000000000000000000000000000000000000000002",
      value:
        "0x000000000000000000000000000000000000000000000000000000000000000b",
    },
  ]);
});

test("selectAccountStorage replays latest slot writes", async () => {
  const schema = createMutationSchema({
    signature: { params: COUNTER_SIGNATURE_PARAMS },
    mutations: { Transfer: transferConfig },
  });
  await applyGeneratedMigration(schema);
  const slot =
    "0x0000000000000000000000000000000000000000000000000000000000000001";

  const storage = await runWithDatabase(
    Effect.gen(function* () {
      const db = yield* Database;
      yield* db.transaction((tx) =>
        insertSlotWrites(tx, schema, { id: 1 }, [
          {
            address: "0x000000000000000000000000000000000000typewriter",
            slot,
            prev_value:
              "0x0000000000000000000000000000000000000000000000000000000000000000",
            new_value:
              "0x000000000000000000000000000000000000000000000000000000000000000a",
          },
        ]),
      );
      yield* db.transaction((tx) =>
        insertSlotWrites(tx, schema, { id: 2 }, [
          {
            address: "0x000000000000000000000000000000000000typewriter",
            slot,
            prev_value:
              "0x000000000000000000000000000000000000000000000000000000000000000a",
            new_value:
              "0x000000000000000000000000000000000000000000000000000000000000000b",
          },
        ]),
      );
      return yield* db.transaction((tx) => selectAccountStorage(tx, schema));
    }),
  );

  expect(storage).toEqual({
    [slot]:
      "0x000000000000000000000000000000000000000000000000000000000000000b",
  });
});

test("selectAccountStorage uses slot writes after redeploy migration cleanup", async () => {
  const schema = createMutationSchema({
    signature: { params: COUNTER_SIGNATURE_PARAMS },
    mutations: { Transfer: transferConfig },
  });
  const chainId = 31341;
  const address =
    "0x000000000000000000000000000000000000typewriter" as Address.Address;
  const schemaName = deploymentSchemaName(chainId, address);
  const slot =
    "0x0000000000000000000000000000000000000000000000000000000000000001";
  const settledValue =
    "0x000000000000000000000000000000000000000000000000000000000000000a";
  const unsettledValue =
    "0x000000000000000000000000000000000000000000000000000000000000000b";

  await runWithDatabase(migrate(schema, chainId, address, 0n));

  await TEST_DB_CONNECTION`
    INSERT INTO ${TEST_DB_CONNECTION(schemaName)}.transfer_mutations
      (id, status, ${TEST_DB_CONNECTION("to")}, amount, ${TEST_DB_CONNECTION("signature_accountId")}, ${TEST_DB_CONNECTION("signature_publicKey")}, ${TEST_DB_CONNECTION("signature_rawSignature")})
    VALUES
      (1, 'included', '0x0000000000000000000000000000000000000001', 1, '0x0000000000000000000000000000000000000000000000000000000000000000', '0x', '0x'),
      (2, 'accepted', '0x0000000000000000000000000000000000000002', 2, '0x0000000000000000000000000000000000000000000000000000000000000000', '0x', '0x')
  `;
  await TEST_DB_CONNECTION`
    INSERT INTO ${TEST_DB_CONNECTION(schemaName)}.slot_writes
      (${TEST_DB_CONNECTION("mutationId")}, slot, value)
    VALUES
      (1, ${slot}, ${settledValue}),
      (2, ${slot}, ${unsettledValue})
  `;

  await runWithDatabase(migrate(schema, chainId, address, 0n));

  const storage = await runWithDatabase(
    Effect.gen(function* () {
      const db = yield* Database;
      return yield* db.transaction((tx) => selectAccountStorage(tx, schema));
    }),
  );

  expect(storage).toEqual({
    [slot]: settledValue,
  });
});

test("insertKnownPaths upserts known paths", async () => {
  const schema = createMutationSchema({
    signature: { params: COUNTER_SIGNATURE_PARAMS },
    mutations: { Transfer: transferConfig },
  });
  await applyGeneratedMigration(schema);

  const paths = await runWithDatabase(
    Effect.gen(function* () {
      const db = yield* Database;
      yield* db.transaction((tx) =>
        insertKnownPaths(tx, schema, [
          "balances[0x0000000000000000000000000000000000000001]",
          "balances[0x0000000000000000000000000000000000000001]",
          "balances[0x0000000000000000000000000000000000000002]",
        ]),
      );
      return yield* db.transaction((tx) => selectKnownPaths(tx, schema));
    }),
  );

  expect(paths).toEqual([
    "balances[0x0000000000000000000000000000000000000001]",
    "balances[0x0000000000000000000000000000000000000002]",
  ]);
});
