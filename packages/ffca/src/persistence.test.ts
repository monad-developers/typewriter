import { expect, test } from "bun:test";
import { parseAbiParameters } from "abitype";
import {
  generateDrizzleJson,
  generateMigration,
} from "drizzle-kit/api-postgres";
import { drizzle } from "drizzle-orm/bun-sql/postgres";
import { Effect } from "effect";
import { TEST_DB_CONNECTION, TEST_DB_URL } from "../test/setup";
import { STUB_FFCA_ABI } from "../test/utils";
import type { FFCAConfig, FFCAMutationConfig } from "./config";
import { Database, layerDatabaseLive } from "./db";
import { updateSchema } from "./migrate";
import {
  persistGeneratedMutation,
  persistUpdatedGeneratedMutationLifecycle,
} from "./persistence";
import { createMutationSchema, mutationStatusEnum } from "./schema";
import type { RuntimeBundle, RuntimeMutation } from "./types";

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

async function applyGeneratedMigration(
  schema: Record<string, unknown>,
): Promise<void> {
  updateSchema(schema as never, "public");
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
    throw new Error(`generated table missing: ${String(name)}`);
  }
  return table as Exclude<Schema[Name], undefined>;
}

const bundle = {
  status: "accepted",
  id: 7,
  position: 11,
  mutations: [],
} satisfies RuntimeBundle;

test("persistGeneratedMutation inserts a generated mutation row", async () => {
  const schema = createMutationSchema({
    abi: STUB_FFCA_ABI,
    mutations: { Debit: debitConfig },
  } satisfies Pick<FFCAConfig, "abi" | "mutations">);
  await applyGeneratedMigration(schema);

  const mutation = {
    status: "accepted",
    id: 1,
    name: "Debit",
    args: {
      account:
        "0x1111111111111111111111111111111111111111111111111111111111111111",
      amount: 123n,
    },
    signature: { keyType: 2, rawSignature: "0xdeadbeef" },
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
      yield* db.transaction((tx) =>
        persistGeneratedMutation(tx, schema, mutation, bundle),
      );
    }),
  );

  const db = drizzle({ client: TEST_DB_CONNECTION });
  const [row] = await db
    .select()
    .from(requiredTable(schema, "debit_mutations"));

  expect(row).toMatchObject({
    id: 1,
    bundleId: 7,
    bundlePosition: 11,
    status: "accepted",
    account:
      "0x1111111111111111111111111111111111111111111111111111111111111111",
    amount: "123",
    signature_keyType: 2,
    signature_rawSignature: "0xdeadbeef",
    resolution_newBalance: "100",
  });
});

test("persistUpdatedGeneratedMutationLifecycle updates generated lifecycle columns", async () => {
  const schema = createMutationSchema({
    abi: STUB_FFCA_ABI,
    mutations: { Transfer: transferConfig },
  } satisfies Pick<FFCAConfig, "abi" | "mutations">);
  await applyGeneratedMigration(schema);

  const mutation = {
    status: "accepted",
    id: 2,
    name: "Transfer",
    args: {
      to: "0x0000000000000000000000000000000000000001",
      amount: 456n,
    },
    signature: { keyType: 2, rawSignature: "0xfeed" },
    isForceInclusion: false,
    config: transferConfig,
  } satisfies Extract<
    RuntimeMutation,
    { status: "accepted" | "included" | "safe" | "finalized" }
  >;

  await runWithDatabase(
    Effect.gen(function* () {
      const db = yield* Database;
      yield* db.transaction((tx) =>
        persistGeneratedMutation(tx, schema, mutation, bundle),
      );
      yield* db.transaction((tx) =>
        persistUpdatedGeneratedMutationLifecycle(tx, schema, {
          ...mutation,
          status: "included",
        }),
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
    amount: "456",
    signature_keyType: 2,
    signature_rawSignature: "0xfeed",
  });
  expect(includedAt).toBeInstanceOf(Date);
});
