import { expect, test } from "bun:test";
import { parseAbiParameters } from "abitype";
import { Effect } from "effect";
import type { Address } from "ox";
import { TEST_DB_CONNECTION, TEST_DB_URL } from "../test/setup";
import {
  COUNTER_SIGNATURE_PARAMS,
  HARNESS_MUTATIONS,
  HARNESS_SIGNATURE_PARAMS,
} from "../test/utils";
import { layerDatabaseLive } from "./db";
import { migrate } from "./migrate";
import { createMutationSchema } from "./schema";

const runMigrate = (
  schema: Record<string, unknown>,
  chainId: number,
  address: Address.Address,
  executionIndex: bigint,
) =>
  Effect.runPromise(
    migrate(schema, chainId, address, executionIndex).pipe(
      Effect.provide(
        layerDatabaseLive({ url: TEST_DB_URL, maxConnections: 1 }),
      ),
    ),
  );

const harnessSchema = () =>
  createMutationSchema({
    signature: { params: HARNESS_SIGNATURE_PARAMS },
    mutations: HARNESS_MUTATIONS,
  });

const HARNESS_TABLES = [
  "assert_mutations",
  "authorize_mutations",
  "credit_mutations",
  "debit_mutations",
  "initialize_mutations",
  "known_paths",
  "slot_writes",
];

test("migrate creates the configured schema", async () => {
  const chainId = 31337;
  const address =
    "0x000000000000000000000000000000000000typewriter" as Address.Address;
  const testSchema =
    "typewriter_31337_0x000000000000000000000000000000000000typewriter";

  const schemaName = await runMigrate(harnessSchema(), chainId, address, 0n);

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
  expect(tables.map((row) => row.table_name)).toEqual(HARNESS_TABLES);
  expect(enums).toEqual([
    {
      enum_name: "mutation_status",
      values: ["accepted", "included", "safe", "finalized"],
    },
  ]);
});

test("migrate is idempotent when schema already exists", async () => {
  const chainId = 31338;
  const address =
    "0x000000000000000000000000000000000000typewriter" as Address.Address;
  const testSchema =
    "typewriter_31338_0x000000000000000000000000000000000000typewriter";

  const firstSchemaName = await runMigrate(
    harnessSchema(),
    chainId,
    address,
    0n,
  );
  const secondSchemaName = await runMigrate(
    harnessSchema(),
    chainId,
    address,
    0n,
  );

  const tables = await TEST_DB_CONNECTION<{ table_name: string }[]>`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = ${testSchema}
      ORDER BY table_name
    `;

  expect(firstSchemaName).toBe(testSchema);
  expect(secondSchemaName).toBe(testSchema);
  expect(tables.map((row) => row.table_name)).toEqual(HARNESS_TABLES);
});

test("migrate deletes unsettled mutations in an existing schema", async () => {
  const chainId = 31339;
  const address =
    "0x000000000000000000000000000000000000typewriter" as Address.Address;
  const schemaName =
    "typewriter_31339_0x000000000000000000000000000000000000typewriter";

  await runMigrate(harnessSchema(), chainId, address, 0n);

  const account =
    "0x0000000000000000000000000000000000000000000000000000000000000001";
  await TEST_DB_CONNECTION`
    INSERT INTO ${TEST_DB_CONNECTION(schemaName)}.credit_mutations
      (id, status, account, ${TEST_DB_CONNECTION("keyId")}, amount, nonce, ${TEST_DB_CONNECTION("signature_account")}, ${TEST_DB_CONNECTION("signature_keyId")}, ${TEST_DB_CONNECTION("signature_keyType")}, ${TEST_DB_CONNECTION("signature_rawSignature")})
    VALUES
      (0, 'accepted', ${account}, 0, 1, 0, ${account}, 0, 2, '0x')
  `;

  await expect(runMigrate(harnessSchema(), chainId, address, 0n)).resolves.toBe(
    schemaName,
  );

  const rows = await TEST_DB_CONNECTION<{ id: number }[]>`
    SELECT id
    FROM ${TEST_DB_CONNECTION(schemaName)}.credit_mutations
  `;
  expect(rows).toEqual([]);
});

test("migrate deletes slot writes for unsettled mutations", async () => {
  const chainId = 31340;
  const address =
    "0x000000000000000000000000000000000000typewriter" as Address.Address;
  const schemaName =
    "typewriter_31340_0x000000000000000000000000000000000000typewriter";
  const schema = createMutationSchema({
    signature: { params: COUNTER_SIGNATURE_PARAMS },
    mutations: {
      add: {
        tag: 0,
        params: parseAbiParameters("uint256 amount"),
      },
    },
  });

  await runMigrate(schema, chainId, address, 0n);

  await TEST_DB_CONNECTION`
    INSERT INTO ${TEST_DB_CONNECTION(schemaName)}.add_mutations
      (id, status, amount, ${TEST_DB_CONNECTION("signature_accountId")}, ${TEST_DB_CONNECTION("signature_publicKey")}, ${TEST_DB_CONNECTION("signature_rawSignature")})
    VALUES
      (0, 'accepted', 1, '0x0000000000000000000000000000000000000000000000000000000000000000', '0x', '0x'),
      (1, 'included', 2, '0x0000000000000000000000000000000000000000000000000000000000000000', '0x', '0x')
  `;
  await TEST_DB_CONNECTION`
    INSERT INTO ${TEST_DB_CONNECTION(schemaName)}.slot_writes
      (${TEST_DB_CONNECTION("mutationId")}, slot, value)
    VALUES
      (0, ${"0x0000000000000000000000000000000000000000000000000000000000000000"}, ${"0x0000000000000000000000000000000000000000000000000000000000000001"}),
      (1, ${"0x0000000000000000000000000000000000000000000000000000000000000001"}, ${"0x0000000000000000000000000000000000000000000000000000000000000002"})
  `;

  await runMigrate(schema, chainId, address, 0n);

  const mutations = await TEST_DB_CONNECTION<{ id: number }[]>`
    SELECT id
    FROM ${TEST_DB_CONNECTION(schemaName)}.add_mutations
    ORDER BY id
  `;
  const slotWrites = await TEST_DB_CONNECTION<{ mutationId: number }[]>`
    SELECT ${TEST_DB_CONNECTION("mutationId")}
    FROM ${TEST_DB_CONNECTION(schemaName)}.slot_writes
    ORDER BY ${TEST_DB_CONNECTION("mutationId")}
  `;

  expect(mutations).toEqual([{ id: 1 }]);
  expect(slotWrites).toEqual([{ mutationId: 1 }]);
});

test("migrate removes newer unsettled slot writes for the same slot", async () => {
  const chainId = 31341;
  const address =
    "0x000000000000000000000000000000000000typewriter" as Address.Address;
  const schemaName =
    "typewriter_31341_0x000000000000000000000000000000000000typewriter";
  const schema = createMutationSchema({
    signature: { params: COUNTER_SIGNATURE_PARAMS },
    mutations: {
      add: {
        tag: 0,
        params: parseAbiParameters("uint256 amount"),
      },
    },
  });
  const slot =
    "0x0000000000000000000000000000000000000000000000000000000000000001";

  await runMigrate(schema, chainId, address, 0n);

  await TEST_DB_CONNECTION`
    INSERT INTO ${TEST_DB_CONNECTION(schemaName)}.add_mutations
      (id, status, amount, ${TEST_DB_CONNECTION("signature_accountId")}, ${TEST_DB_CONNECTION("signature_publicKey")}, ${TEST_DB_CONNECTION("signature_rawSignature")})
    VALUES
      (0, 'included', 7, '0x0000000000000000000000000000000000000000000000000000000000000000', '0x', '0x'),
      (1, 'accepted', 11, '0x0000000000000000000000000000000000000000000000000000000000000000', '0x', '0x')
  `;
  await TEST_DB_CONNECTION`
    INSERT INTO ${TEST_DB_CONNECTION(schemaName)}.slot_writes
      (${TEST_DB_CONNECTION("mutationId")}, slot, value)
    VALUES
      (0, ${slot}, ${"0x0000000000000000000000000000000000000000000000000000000000000007"}),
      (1, ${slot}, ${"0x000000000000000000000000000000000000000000000000000000000000000b"})
  `;

  await runMigrate(schema, chainId, address, 0n);

  const mutations = await TEST_DB_CONNECTION<{ id: number }[]>`
    SELECT id
    FROM ${TEST_DB_CONNECTION(schemaName)}.add_mutations
    ORDER BY id
  `;
  const slotWrites = await TEST_DB_CONNECTION<
    { mutationId: number; slot: string; value: string }[]
  >`
    SELECT ${TEST_DB_CONNECTION("mutationId")}, slot, value
    FROM ${TEST_DB_CONNECTION(schemaName)}.slot_writes
    ORDER BY id
  `;

  expect(mutations).toEqual([{ id: 0 }]);
  expect(slotWrites).toEqual([
    {
      mutationId: 0,
      slot,
      value:
        "0x0000000000000000000000000000000000000000000000000000000000000007",
    },
  ]);
});

test("migrate recovers accepted mutations below the onchain applied count", async () => {
  const chainId = 31342;
  const address =
    "0x000000000000000000000000000000000000typewriter" as Address.Address;
  const schemaName =
    "typewriter_31342_0x000000000000000000000000000000000000typewriter";
  const schema = createMutationSchema({
    signature: { params: COUNTER_SIGNATURE_PARAMS },
    mutations: {
      add: {
        tag: 0,
        params: parseAbiParameters("uint256 amount"),
      },
    },
  });
  const slot =
    "0x0000000000000000000000000000000000000000000000000000000000000001";

  await runMigrate(schema, chainId, address, 0n);

  await TEST_DB_CONNECTION`
    INSERT INTO ${TEST_DB_CONNECTION(schemaName)}.add_mutations
      (id, ${TEST_DB_CONNECTION("executionIndex")}, status, amount, ${TEST_DB_CONNECTION("signature_accountId")}, ${TEST_DB_CONNECTION("signature_publicKey")}, ${TEST_DB_CONNECTION("signature_rawSignature")})
    VALUES
      (0, 0, 'accepted', 7, '0x0000000000000000000000000000000000000000000000000000000000000000', '0x', '0x'),
      (1, 1, 'accepted', 11, '0x0000000000000000000000000000000000000000000000000000000000000000', '0x', '0x')
  `;
  await TEST_DB_CONNECTION`
    INSERT INTO ${TEST_DB_CONNECTION(schemaName)}.slot_writes
      (${TEST_DB_CONNECTION("mutationId")}, slot, value)
    VALUES
      (0, ${slot}, ${"0x0000000000000000000000000000000000000000000000000000000000000007"}),
      (1, ${slot}, ${"0x000000000000000000000000000000000000000000000000000000000000000b"})
  `;

  await runMigrate(schema, chainId, address, 1n);

  const mutations = await TEST_DB_CONNECTION<
    { id: number; executionIndex: string; status: string }[]
  >`
    SELECT id, ${TEST_DB_CONNECTION("executionIndex")}, status
    FROM ${TEST_DB_CONNECTION(schemaName)}.add_mutations
    ORDER BY id
  `;
  const slotWrites = await TEST_DB_CONNECTION<
    { mutationId: number; slot: string; value: string }[]
  >`
    SELECT ${TEST_DB_CONNECTION("mutationId")}, slot, value
    FROM ${TEST_DB_CONNECTION(schemaName)}.slot_writes
    ORDER BY id
  `;

  expect(mutations).toEqual([
    { id: 0, executionIndex: "0", status: "included" },
  ]);
  expect(slotWrites).toEqual([
    {
      mutationId: 0,
      slot,
      value:
        "0x0000000000000000000000000000000000000000000000000000000000000007",
    },
  ]);
});
