import { expect, test } from "bun:test";
import { parseAbiParameters } from "abitype";
import {
  generateDrizzleJson,
  generateMigration,
} from "drizzle-kit/api-postgres";
import { drizzle } from "drizzle-orm/bun-sql/postgres";
import type { PgTable } from "drizzle-orm/pg-core";
import { Effect } from "effect";
import { TEST_DB_CONNECTION, TEST_DB_URL } from "../test/setup";
import { COUNTER_SIGNATURE_PARAMS } from "../test/utils";
import type { FFCAConfig, FFCAMutationConfig } from "./config";
import { Database, layerDatabaseLive } from "./db";
import {
  insertKnownPaths,
  insertMutation,
  insertSlotWrites,
  selectAccountStorage,
  selectKnownPaths,
  updateMutationLifecycle,
} from "./db-query";
import { updateSchema } from "./migrate";
import { createMutationSchema, mutationStatusEnum } from "./schema";
import type { RuntimeBlock, RuntimeMutation } from "./types";

const transferConfig = {
  tag: 0,
  params: parseAbiParameters("address to, uint256 amount"),
} satisfies FFCAMutationConfig;

const debitConfig = {
  tag: 1,
  params: parseAbiParameters("bytes32 account, uint256 amount"),
  resolution: parseAbiParameters("uint256 newBalance"),
  resolve: () => ({ newBalance: 0n }),
} satisfies FFCAMutationConfig;

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
  } satisfies Pick<FFCAConfig, "signature" | "mutations">);
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
    resolution: { newBalance: 100n },
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
    resolution_newBalance: 100n,
  });
});

test("updateMutationLifecycle updates lifecycle columns", async () => {
  const schema = createMutationSchema({
    signature: { params: COUNTER_SIGNATURE_PARAMS },
    mutations: { Transfer: transferConfig },
  } satisfies Pick<FFCAConfig, "signature" | "mutations">);
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

test("insertSlotWrites records raw slot writes", async () => {
  const schema = createMutationSchema({
    signature: { params: COUNTER_SIGNATURE_PARAMS },
    mutations: { Transfer: transferConfig },
  } satisfies Pick<FFCAConfig, "signature" | "mutations">);
  await applyGeneratedMigration(schema);

  await runWithDatabase(
    Effect.gen(function* () {
      const db = yield* Database;
      yield* db.transaction((tx) =>
        insertSlotWrites(tx, schema, { id: 42 }, [
          {
            address: "0x000000000000000000000000000000000000ffca",
            slot: "0x0000000000000000000000000000000000000000000000000000000000000001",
            prev_value:
              "0x0000000000000000000000000000000000000000000000000000000000000000",
            new_value:
              "0x000000000000000000000000000000000000000000000000000000000000000a",
          },
          {
            address: "0x000000000000000000000000000000000000ffca",
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
  } satisfies Pick<FFCAConfig, "signature" | "mutations">);
  await applyGeneratedMigration(schema);
  const slot =
    "0x0000000000000000000000000000000000000000000000000000000000000001";

  const storage = await runWithDatabase(
    Effect.gen(function* () {
      const db = yield* Database;
      yield* db.transaction((tx) =>
        insertSlotWrites(tx, schema, { id: 1 }, [
          {
            address: "0x000000000000000000000000000000000000ffca",
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
            address: "0x000000000000000000000000000000000000ffca",
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

test("insertKnownPaths upserts known paths", async () => {
  const schema = createMutationSchema({
    signature: { params: COUNTER_SIGNATURE_PARAMS },
    mutations: { Transfer: transferConfig },
  } satisfies Pick<FFCAConfig, "signature" | "mutations">);
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
