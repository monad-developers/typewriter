import { expect, expectTypeOf, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { type AbiParameter, parseAbiParameters } from "abitype";
import {
  generateDrizzleJson,
  generateMigration,
} from "drizzle-kit/api-postgres";
import { integer, pgTable } from "drizzle-orm/pg-core";
import { drizzle } from "drizzle-orm/pglite";
import {
  type AbiParametersToColumns,
  type AbiParameterToColumn,
  abiParametersToColumns,
  abiParameterToColumn,
} from "./index";

type Hex = `0x${string}`;

async function applyGeneratedMigration(
  client: PGlite,
  schema: Record<string, unknown>,
): Promise<string[]> {
  const empty = await generateDrizzleJson({});
  const target = await generateDrizzleJson(schema);
  const statements = await generateMigration(empty, target);
  for (const statement of statements) {
    await client.exec(statement);
  }
  return statements;
}

function createMutationTable<const Params extends readonly AbiParameter[]>(
  params: Params,
) {
  return pgTable("mutation", {
    id: integer().primaryKey(),
    ...abiParametersToColumns(params),
  });
}

function columnDefinitions(
  statements: readonly string[],
  names: readonly string[],
): string[] {
  const lines = statements.join("\n").split("\n");
  return names.map((name) => {
    const definition = lines.find((line) =>
      line.trim().startsWith(`"${name}" `),
    );
    if (definition === undefined) {
      throw new Error(`column not found in generated migration: ${name}`);
    }
    return definition.trim().replace(/,$/, "").replaceAll('"', "");
  });
}

test("exports only the column generation API", async () => {
  const module = await import("./index");
  expect(Object.keys(module).sort()).toMatchInlineSnapshot(`
    [
      "abiParameterToColumn",
      "abiParametersToColumns",
    ]
  `);
});

test("single ABI parameter generates a Drizzle column", () => {
  const column = abiParameterToColumn(
    parseAbiParameters(["address account"])[0]!,
  );
  const mutation = pgTable("single_column", { account: column });

  type Insert = typeof mutation.$inferInsert;
  expectTypeOf<Insert>().toExtend<{ account: Hex }>();
});

test("creates deterministic columns from ABI params", () => {
  const params = parseAbiParameters(["address account", "uint256"]);

  const columns = abiParametersToColumns(params);
  expect(Object.keys(columns)).toMatchInlineSnapshot(`
    [
      "account",
      "arg1",
    ]
  `);
});

test("rejects duplicate column names", () => {
  const params = parseAbiParameters(["address account", "uint256 account"]);

  let error: unknown;
  try {
    abiParametersToColumns(params);
  } catch (caught) {
    error = caught;
  }

  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).toMatchInlineSnapshot(
    `"duplicate ABI parameter column name: account"`,
  );
});

test("integer ABI types round-trip through Drizzle-generated migrations", async () => {
  const integerParams = parseAbiParameters([
    "uint uintDefault",
    "uint8 u8",
    "uint16 u16",
    "uint24 u24",
    "uint32 u32",
    "uint40 u40",
    "uint48 u48",
    "uint56 u56",
    "uint64 u64",
    "uint72 u72",
    "uint80 u80",
    "uint88 u88",
    "uint96 u96",
    "uint104 u104",
    "uint112 u112",
    "uint120 u120",
    "uint128 u128",
    "uint136 u136",
    "uint144 u144",
    "uint152 u152",
    "uint160 u160",
    "uint168 u168",
    "uint176 u176",
    "uint184 u184",
    "uint192 u192",
    "uint200 u200",
    "uint208 u208",
    "uint216 u216",
    "uint224 u224",
    "uint232 u232",
    "uint240 u240",
    "uint248 u248",
    "uint256 u256",
    "int intDefault",
    "int8 i8",
    "int16 i16",
    "int24 i24",
    "int32 i32",
    "int40 i40",
    "int48 i48",
    "int56 i56",
    "int64 i64",
    "int72 i72",
    "int80 i80",
    "int88 i88",
    "int96 i96",
    "int104 i104",
    "int112 i112",
    "int120 i120",
    "int128 i128",
    "int136 i136",
    "int144 i144",
    "int152 i152",
    "int160 i160",
    "int168 i168",
    "int176 i176",
    "int184 i184",
    "int192 i192",
    "int200 i200",
    "int208 i208",
    "int216 i216",
    "int224 i224",
    "int232 i232",
    "int240 i240",
    "int248 i248",
    "int256 i256",
  ]);
  const mutation = createMutationTable(integerParams);
  const client = new PGlite();
  const db = drizzle({ client });
  const statements = await applyGeneratedMigration(client, { mutation });
  const row: { id: number } & Record<string, unknown> = { id: 1 };

  Object.assign(row, {
    uintDefault: 2n ** 256n - 1n,
    intDefault: -(2n ** 255n),
  });
  for (let bits = 8; bits <= 256; bits += 8) {
    const uintKey = `u${bits}`;
    const intKey = `i${bits}`;
    row[uintKey] = unsignedTestValue(bits);
    row[intKey] = signedTestValue(bits);
  }

  await db.insert(mutation).values(row as typeof mutation.$inferInsert);
  const [selected] = await db.select().from(mutation);

  expect(
    columnDefinitions(statements, [
      "uintDefault",
      "u8",
      "u16",
      "u24",
      "u32",
      "u56",
      "u64",
      "intDefault",
      "i8",
      "i16",
      "i24",
      "i32",
      "i40",
      "i64",
      "i72",
    ]),
  ).toMatchInlineSnapshot(`
    [
      "uintDefault numeric(78,0) NOT NULL",
      "u8 smallint NOT NULL",
      "u16 integer NOT NULL",
      "u24 integer NOT NULL",
      "u32 bigint NOT NULL",
      "u56 bigint NOT NULL",
      "u64 numeric(78,0) NOT NULL",
      "intDefault numeric(78,0) NOT NULL",
      "i8 smallint NOT NULL",
      "i16 smallint NOT NULL",
      "i24 integer NOT NULL",
      "i32 integer NOT NULL",
      "i40 bigint NOT NULL",
      "i64 bigint NOT NULL",
      "i72 numeric(78,0) NOT NULL",
    ]
  `);
  expect({
    uintDefault: selected?.uintDefault,
    u8: selected?.u8,
    u32: selected?.u32,
    u64: selected?.u64,
    intDefault: selected?.intDefault,
    i8: selected?.i8,
    i40: selected?.i40,
    i72: selected?.i72,
  }).toMatchInlineSnapshot(`
    {
      "i40": -549755813888n,
      "i72": -2361183241434822606848n,
      "i8": -128,
      "intDefault": -57896044618658097711785492504343953926634992332820282019728792003956564819968n,
      "u32": 4294967295n,
      "u64": 18446744073709551615n,
      "u8": 255,
      "uintDefault": 115792089237316195423570985008687907853269984665640564039457584007913129639935n,
    }
  `);
  expect(selected).toMatchObject(row);
});

test("bytes and text ABI types round-trip through Drizzle-generated migrations", async () => {
  const byteParams = parseAbiParameters([
    "bytes1 b1",
    "bytes2 b2",
    "bytes3 b3",
    "bytes4 b4",
    "bytes5 b5",
    "bytes6 b6",
    "bytes7 b7",
    "bytes8 b8",
    "bytes9 b9",
    "bytes10 b10",
    "bytes11 b11",
    "bytes12 b12",
    "bytes13 b13",
    "bytes14 b14",
    "bytes15 b15",
    "bytes16 b16",
    "bytes17 b17",
    "bytes18 b18",
    "bytes19 b19",
    "bytes20 b20",
    "bytes21 b21",
    "bytes22 b22",
    "bytes23 b23",
    "bytes24 b24",
    "bytes25 b25",
    "bytes26 b26",
    "bytes27 b27",
    "bytes28 b28",
    "bytes29 b29",
    "bytes30 b30",
    "bytes31 b31",
    "bytes32 b32",
    "bytes dynamicBytes",
    "string memo",
    "function callback",
  ]);
  const mutation = createMutationTable(byteParams);
  const client = new PGlite();
  const db = drizzle({ client });
  const statements = await applyGeneratedMigration(client, { mutation });
  const row: { id: number } & Record<string, unknown> = { id: 1 };

  for (let byteLength = 1; byteLength <= 32; byteLength++) {
    row[`b${byteLength}`] = `0x${"aa".repeat(byteLength)}`;
  }
  Object.assign(row, {
    dynamicBytes: "0xdeadbeef",
    memo: "hello",
    callback: `0x${"12".repeat(24)}`,
  });

  await db.insert(mutation).values(row as typeof mutation.$inferInsert);
  const [selected] = await db.select().from(mutation);

  expect(
    columnDefinitions(statements, [
      "b1",
      "b2",
      "b31",
      "b32",
      "dynamicBytes",
      "memo",
      "callback",
    ]),
  ).toMatchInlineSnapshot(`
    [
      "b1 char(4) NOT NULL",
      "b2 char(6) NOT NULL",
      "b31 char(64) NOT NULL",
      "b32 char(66) NOT NULL",
      "dynamicBytes text NOT NULL",
      "memo text NOT NULL",
      "callback char(50) NOT NULL",
    ]
  `);
  expect({
    b1: selected?.b1,
    b32: selected?.b32,
    dynamicBytes: selected?.dynamicBytes,
    memo: selected?.memo,
    callback: selected?.callback,
  }).toMatchInlineSnapshot(`
    {
      "b1": "0xaa",
      "b32": "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "callback": "0x121212121212121212121212121212121212121212121212",
      "dynamicBytes": "0xdeadbeef",
      "memo": "hello",
    }
  `);
  expect(selected).toMatchObject(row);

  type Insert = typeof mutation.$inferInsert;
  expectTypeOf<Insert>().toExtend<{
    b1: Hex;
    b32: Hex;
    dynamicBytes: Hex;
    callback: Hex;
    memo: string;
  }>();
});

test("misc scalar ABI types round-trip through Drizzle-generated migrations", async () => {
  const params = parseAbiParameters(["bool ok", "address account"]);
  const mutation = createMutationTable(params);
  const client = new PGlite();
  const db = drizzle({ client });
  const statements = await applyGeneratedMigration(client, { mutation });
  const row = {
    id: 1,
    ok: true,
    account: "0x0000000000000000000000000000000000000001" as Hex,
  };

  await db.insert(mutation).values(row as typeof mutation.$inferInsert);
  const [selected] = await db.select().from(mutation);

  expect(
    columnDefinitions(statements, ["ok", "account"]),
  ).toMatchInlineSnapshot(`
      [
        "ok boolean NOT NULL",
        "account char(42) NOT NULL",
      ]
    `);
  expect(selected).toMatchInlineSnapshot(`
    {
      "account": "0x0000000000000000000000000000000000000001",
      "id": 1,
      "ok": true,
    }
  `);
});

test("complex ABI types use jsonb and preserve inferred JSON-safe types", async () => {
  const params = parseAbiParameters([
    "uint256[] amounts",
    "uint64[2][] matrix",
    "(address account, uint256 amount, bool[] flags) order",
    "(uint64 quantity, uint64 price, (address account, uint256 nonce) maker)[] fills",
  ]);
  const mutation = createMutationTable(params);
  const client = new PGlite();
  const db = drizzle({ client });
  const statements = await applyGeneratedMigration(client, { mutation });
  const row = {
    id: 1,
    amounts: ["1", "2"],
    matrix: [
      ["3", "4"],
      ["5", "6"],
    ],
    order: {
      account: "0x0000000000000000000000000000000000000001",
      amount: "7",
      flags: [true, false],
    },
    fills: [
      {
        quantity: "8",
        price: "9",
        maker: {
          account: "0x0000000000000000000000000000000000000002",
          nonce: "10",
        },
      },
    ],
  } satisfies typeof mutation.$inferInsert;

  type Insert = typeof mutation.$inferInsert;
  expectTypeOf<Insert>().toExtend<{
    id?: number;
    amounts: readonly string[];
    matrix: readonly (readonly string[])[];
    order: {
      readonly account: string;
      readonly amount: string;
      readonly flags: readonly boolean[];
    };
    fills: readonly {
      readonly quantity: string;
      readonly price: string;
      readonly maker: { readonly account: string; readonly nonce: string };
    }[];
  }>();

  await db.insert(mutation).values(row);
  const [selected] = await db.select().from(mutation);

  expect(
    columnDefinitions(statements, ["amounts", "matrix", "order", "fills"]),
  ).toMatchInlineSnapshot(`
      [
        "amounts jsonb NOT NULL",
        "matrix jsonb NOT NULL",
        "order jsonb NOT NULL",
        "fills jsonb NOT NULL",
      ]
    `);
  expect(selected).toMatchInlineSnapshot(`
    {
      "amounts": [
        "1",
        "2",
      ],
      "fills": [
        {
          "maker": {
            "account": "0x0000000000000000000000000000000000000002",
            "nonce": "10",
          },
          "price": "9",
          "quantity": "8",
        },
      ],
      "id": 1,
      "matrix": [
        [
          "3",
          "4",
        ],
        [
          "5",
          "6",
        ],
      ],
      "order": {
        "account": "0x0000000000000000000000000000000000000001",
        "amount": "7",
        "flags": [
          true,
          false,
        ],
      },
    }
  `);
});

test("exported generic column types can describe generated columns", () => {
  const singleParams = parseAbiParameters(["uint256 amount"]);
  const manyParams = parseAbiParameters(["address account", "uint256 amount"]);
  type Single = AbiParameterToColumn<(typeof singleParams)[0]>;
  type Many = AbiParametersToColumns<typeof manyParams>;

  expectTypeOf<Single>().not.toBeNever();
  expectTypeOf<Many>().toHaveProperty("account");
  expectTypeOf<Many>().toHaveProperty("amount");
});

function unsignedTestValue(bits: number): number | bigint {
  if (bits <= 24) return Number(2n ** BigInt(bits) - 1n);
  return 2n ** BigInt(bits) - 1n;
}

function signedTestValue(bits: number): number | bigint {
  const value = -(2n ** BigInt(bits - 1));
  if (bits <= 32) return Number(value);
  return value;
}
