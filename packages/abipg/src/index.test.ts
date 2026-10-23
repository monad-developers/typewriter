import { expect, expectTypeOf, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import type { AbiParameter } from "abitype";
import { generateDrizzleJson, generateMigration } from "drizzle-kit/api";
import { integer, type PgTable, pgTable } from "drizzle-orm/pg-core";
import { drizzle } from "drizzle-orm/pglite";
import { AbiParameters } from "ox";
import {
  type AbiParametersToColumns,
  type AbiParameterToColumn,
  abiParametersToColumns,
  abiParametersToValues,
  abiParameterToColumn,
} from "./index";

type Hex = `0x${string}`;

function createMutationTable<const Params extends readonly AbiParameter[]>(
  params: Params,
) {
  return pgTable("mutation", {
    id: integer().primaryKey(),
    ...abiParametersToColumns(params),
  });
}

/** Create `table` in a new PGlite database and return the DDL. */
async function setup(table: PgTable) {
  const client = new PGlite();
  const db = drizzle({ client });
  const empty = await generateDrizzleJson({});
  const target = await generateDrizzleJson({ table });
  const statements = await generateMigration(empty, target);
  for (const statement of statements) await client.exec(statement);
  return { db, ddl: statements.join("\n") };
}

/** Insert one row per value list with `abiParametersToValues`, then select all rows. */
async function roundTrip(
  params: readonly AbiParameter[],
  rows: readonly (readonly unknown[])[],
) {
  const table = createMutationTable(params);
  const { db, ddl } = await setup(table);
  for (const [index, values] of rows.entries()) {
    await db.insert(table).values({
      id: index,
      ...abiParametersToValues(params, values),
    } as typeof table.$inferInsert);
  }
  const selected = await db.select().from(table).orderBy(table.id);
  return { ddl, selected };
}

function errorMessage(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error("expected an error");
}

const INTEGER_BITS = Array.from({ length: 32 }, (_, index) => (index + 1) * 8);

const INTEGER_PARAMS = AbiParameters.from([
  "uint uintDefault",
  "int intDefault",
  ...INTEGER_BITS.map((bits) => `uint${bits} u${bits}`),
  ...INTEGER_BITS.map((bits) => `int${bits} i${bits}`),
] as unknown as readonly ["uint uintDefault"]) as readonly AbiParameter[];

const BYTES_PARAMS = AbiParameters.from(
  Array.from(
    { length: 32 },
    (_, index) => `bytes${index + 1} b${index + 1}`,
  ) as unknown as readonly ["bytes1 b1"],
) as readonly AbiParameter[];

test("abiParameterToColumn builds one not-null column", async () => {
  const column = abiParameterToColumn(
    AbiParameters.from(["address account"])[0],
  );
  const table = pgTable("single", { account: column });
  const { ddl } = await setup(table);

  expect(ddl).toMatchInlineSnapshot(`
    "CREATE TABLE "single" (
    	"account" char(42) NOT NULL
    );
    "
  `);
  expectTypeOf<typeof table.$inferInsert>().toEqualTypeOf<{
    account: Hex;
  }>();
});

test("columns are named by parameter name, or by position when unnamed", () => {
  const params = [
    ...AbiParameters.from(["address account", "uint256", "bool"]),
    { type: "uint8", name: "" },
  ] as const;

  expect(Object.keys(abiParametersToColumns(params))).toMatchInlineSnapshot(`
    [
      "account",
      "arg1",
      "arg2",
      "arg3",
    ]
  `);
  expectTypeOf<keyof AbiParametersToColumns<typeof params>>().toEqualTypeOf<
    "account" | "arg1" | "arg2" | "arg3"
  >();
});

test("duplicate column names throw", () => {
  expect([
    errorMessage(() =>
      abiParametersToColumns(
        AbiParameters.from(["address account", "uint256 account"]),
      ),
    ),
    errorMessage(() =>
      abiParametersToColumns([
        { type: "uint256", name: "arg1" },
        { type: "uint256" },
      ]),
    ),
  ]).toMatchInlineSnapshot(`
    [
      "duplicate ABI parameter column name: account",
      "duplicate ABI parameter column name: arg1",
    ]
  `);
});

test("unsupported ABI types throw for columns and values", () => {
  const types = [
    "fixed128x18",
    "ufixed128x18",
    "fixed",
    "bytes0",
    "bytes33",
    "uint0",
    "uint7",
    "uint264",
    "int7",
    "int264",
    "fixed128x18[]",
    "unknown",
  ];
  const nested = {
    type: "tuple",
    name: "order",
    components: [
      { type: "uint256", name: "amount" },
      { type: "fixed128x18[2]", name: "price" },
    ],
  } as const;

  expect({
    columns: types.map((type) =>
      errorMessage(() => abiParameterToColumn({ type, name: "x" })),
    ),
    values: types.map((type) =>
      errorMessage(() => abiParametersToValues([{ type, name: "x" }], [1])),
    ),
    nestedColumn: errorMessage(() => abiParameterToColumn(nested)),
  }).toMatchInlineSnapshot(`
    {
      "columns": [
        "unsupported ABI type: fixed128x18",
        "unsupported ABI type: ufixed128x18",
        "unsupported ABI type: fixed",
        "unsupported ABI type: bytes0",
        "unsupported ABI type: bytes33",
        "invalid ABI integer type: uint0",
        "invalid ABI integer type: uint7",
        "invalid ABI integer type: uint264",
        "invalid ABI integer type: int7",
        "invalid ABI integer type: int264",
        "unsupported ABI type: fixed128x18",
        "unsupported ABI type: unknown",
      ],
      "nestedColumn": "unsupported ABI type: fixed128x18",
      "values": [
        "unsupported ABI type: fixed128x18",
        "unsupported ABI type: ufixed128x18",
        "unsupported ABI type: fixed",
        "unsupported ABI type: bytes0",
        "unsupported ABI type: bytes33",
        "invalid ABI integer type: uint0",
        "invalid ABI integer type: uint7",
        "invalid ABI integer type: uint264",
        "invalid ABI integer type: int7",
        "invalid ABI integer type: int264",
        "unsupported ABI type: fixed128x18",
        "unsupported ABI type: unknown",
      ],
    }
  `);
});

test("integer types of every width map to the smallest exact column and round-trip", async () => {
  const maxRow = [
    2n ** 256n - 1n,
    2n ** 255n - 1n,
    ...INTEGER_BITS.map((bits) => 2n ** BigInt(bits) - 1n),
    ...INTEGER_BITS.map((bits) => 2n ** BigInt(bits - 1) - 1n),
  ];
  const minRow = [
    0n,
    -(2n ** 255n),
    ...INTEGER_BITS.map(() => 0n),
    ...INTEGER_BITS.map((bits) => -(2n ** BigInt(bits - 1))),
  ];

  const { ddl, selected } = await roundTrip(INTEGER_PARAMS, [maxRow, minRow]);

  expect(ddl).toMatchInlineSnapshot(`
    "CREATE TABLE "mutation" (
    	"id" integer PRIMARY KEY NOT NULL,
    	"uintDefault" numeric(78, 0) NOT NULL,
    	"intDefault" numeric(78, 0) NOT NULL,
    	"u8" smallint NOT NULL,
    	"u16" integer NOT NULL,
    	"u24" integer NOT NULL,
    	"u32" bigint NOT NULL,
    	"u40" bigint NOT NULL,
    	"u48" bigint NOT NULL,
    	"u56" bigint NOT NULL,
    	"u64" numeric(78, 0) NOT NULL,
    	"u72" numeric(78, 0) NOT NULL,
    	"u80" numeric(78, 0) NOT NULL,
    	"u88" numeric(78, 0) NOT NULL,
    	"u96" numeric(78, 0) NOT NULL,
    	"u104" numeric(78, 0) NOT NULL,
    	"u112" numeric(78, 0) NOT NULL,
    	"u120" numeric(78, 0) NOT NULL,
    	"u128" numeric(78, 0) NOT NULL,
    	"u136" numeric(78, 0) NOT NULL,
    	"u144" numeric(78, 0) NOT NULL,
    	"u152" numeric(78, 0) NOT NULL,
    	"u160" numeric(78, 0) NOT NULL,
    	"u168" numeric(78, 0) NOT NULL,
    	"u176" numeric(78, 0) NOT NULL,
    	"u184" numeric(78, 0) NOT NULL,
    	"u192" numeric(78, 0) NOT NULL,
    	"u200" numeric(78, 0) NOT NULL,
    	"u208" numeric(78, 0) NOT NULL,
    	"u216" numeric(78, 0) NOT NULL,
    	"u224" numeric(78, 0) NOT NULL,
    	"u232" numeric(78, 0) NOT NULL,
    	"u240" numeric(78, 0) NOT NULL,
    	"u248" numeric(78, 0) NOT NULL,
    	"u256" numeric(78, 0) NOT NULL,
    	"i8" smallint NOT NULL,
    	"i16" smallint NOT NULL,
    	"i24" integer NOT NULL,
    	"i32" integer NOT NULL,
    	"i40" bigint NOT NULL,
    	"i48" bigint NOT NULL,
    	"i56" bigint NOT NULL,
    	"i64" bigint NOT NULL,
    	"i72" numeric(78, 0) NOT NULL,
    	"i80" numeric(78, 0) NOT NULL,
    	"i88" numeric(78, 0) NOT NULL,
    	"i96" numeric(78, 0) NOT NULL,
    	"i104" numeric(78, 0) NOT NULL,
    	"i112" numeric(78, 0) NOT NULL,
    	"i120" numeric(78, 0) NOT NULL,
    	"i128" numeric(78, 0) NOT NULL,
    	"i136" numeric(78, 0) NOT NULL,
    	"i144" numeric(78, 0) NOT NULL,
    	"i152" numeric(78, 0) NOT NULL,
    	"i160" numeric(78, 0) NOT NULL,
    	"i168" numeric(78, 0) NOT NULL,
    	"i176" numeric(78, 0) NOT NULL,
    	"i184" numeric(78, 0) NOT NULL,
    	"i192" numeric(78, 0) NOT NULL,
    	"i200" numeric(78, 0) NOT NULL,
    	"i208" numeric(78, 0) NOT NULL,
    	"i216" numeric(78, 0) NOT NULL,
    	"i224" numeric(78, 0) NOT NULL,
    	"i232" numeric(78, 0) NOT NULL,
    	"i240" numeric(78, 0) NOT NULL,
    	"i248" numeric(78, 0) NOT NULL,
    	"i256" numeric(78, 0) NOT NULL
    );
    "
  `);
  expect(selected).toMatchInlineSnapshot(`
    [
      {
        "i104": 10141204801825835211973625643007n,
        "i112": 2596148429267413814265248164610047n,
        "i120": 664613997892457936451903530140172287n,
        "i128": 170141183460469231731687303715884105727n,
        "i136": 43556142965880123323311949751266331066367n,
        "i144": 11150372599265311570767859136324180752990207n,
        "i152": 2854495385411919762116571938898990272765493247n,
        "i16": 32767,
        "i160": 730750818665451459101842416358141509827966271487n,
        "i168": 187072209578355573530071658587684226515959365500927n,
        "i176": 47890485652059026823698344598447161988085597568237567n,
        "i184": 12259964326927110866866776217202473468949912977468817407n,
        "i192": 3138550867693340381917894711603833208051177722232017256447n,
        "i200": 803469022129495137770981046170581301261101496891396417650687n,
        "i208": 205688069665150755269371147819668813122841983204197482918576127n,
        "i216": 52656145834278593348959013841835216159447547700274555627155488767n,
        "i224": 13479973333575319897333507543509815336818572211270286240551805124607n,
        "i232": 3450873173395281893717377931138512726225554486085193277581262111899647n,
        "i24": 8388607,
        "i240": 883423532389192164791648750371459257913741948437809479060803100646309887n,
        "i248": 226156424291633194186662080095093570025917938800079226639565593765455331327n,
        "i256": 57896044618658097711785492504343953926634992332820282019728792003956564819967n,
        "i32": 2147483647,
        "i40": 549755813887n,
        "i48": 140737488355327n,
        "i56": 36028797018963967n,
        "i64": 9223372036854775807n,
        "i72": 2361183241434822606847n,
        "i8": 127,
        "i80": 604462909807314587353087n,
        "i88": 154742504910672534362390527n,
        "i96": 39614081257132168796771975167n,
        "id": 0,
        "intDefault": 57896044618658097711785492504343953926634992332820282019728792003956564819967n,
        "u104": 20282409603651670423947251286015n,
        "u112": 5192296858534827628530496329220095n,
        "u120": 1329227995784915872903807060280344575n,
        "u128": 340282366920938463463374607431768211455n,
        "u136": 87112285931760246646623899502532662132735n,
        "u144": 22300745198530623141535718272648361505980415n,
        "u152": 5708990770823839524233143877797980545530986495n,
        "u16": 65535,
        "u160": 1461501637330902918203684832716283019655932542975n,
        "u168": 374144419156711147060143317175368453031918731001855n,
        "u176": 95780971304118053647396689196894323976171195136475135n,
        "u184": 24519928653854221733733552434404946937899825954937634815n,
        "u192": 6277101735386680763835789423207666416102355444464034512895n,
        "u200": 1606938044258990275541962092341162602522202993782792835301375n,
        "u208": 411376139330301510538742295639337626245683966408394965837152255n,
        "u216": 105312291668557186697918027683670432318895095400549111254310977535n,
        "u224": 26959946667150639794667015087019630673637144422540572481103610249215n,
        "u232": 6901746346790563787434755862277025452451108972170386555162524223799295n,
        "u24": 16777215,
        "u240": 1766847064778384329583297500742918515827483896875618958121606201292619775n,
        "u248": 452312848583266388373324160190187140051835877600158453279131187530910662655n,
        "u256": 115792089237316195423570985008687907853269984665640564039457584007913129639935n,
        "u32": 4294967295n,
        "u40": 1099511627775n,
        "u48": 281474976710655n,
        "u56": 72057594037927935n,
        "u64": 18446744073709551615n,
        "u72": 4722366482869645213695n,
        "u8": 255,
        "u80": 1208925819614629174706175n,
        "u88": 309485009821345068724781055n,
        "u96": 79228162514264337593543950335n,
        "uintDefault": 115792089237316195423570985008687907853269984665640564039457584007913129639935n,
      },
      {
        "i104": -10141204801825835211973625643008n,
        "i112": -2596148429267413814265248164610048n,
        "i120": -664613997892457936451903530140172288n,
        "i128": -170141183460469231731687303715884105728n,
        "i136": -43556142965880123323311949751266331066368n,
        "i144": -11150372599265311570767859136324180752990208n,
        "i152": -2854495385411919762116571938898990272765493248n,
        "i16": -32768,
        "i160": -730750818665451459101842416358141509827966271488n,
        "i168": -187072209578355573530071658587684226515959365500928n,
        "i176": -47890485652059026823698344598447161988085597568237568n,
        "i184": -12259964326927110866866776217202473468949912977468817408n,
        "i192": -3138550867693340381917894711603833208051177722232017256448n,
        "i200": -803469022129495137770981046170581301261101496891396417650688n,
        "i208": -205688069665150755269371147819668813122841983204197482918576128n,
        "i216": -52656145834278593348959013841835216159447547700274555627155488768n,
        "i224": -13479973333575319897333507543509815336818572211270286240551805124608n,
        "i232": -3450873173395281893717377931138512726225554486085193277581262111899648n,
        "i24": -8388608,
        "i240": -883423532389192164791648750371459257913741948437809479060803100646309888n,
        "i248": -226156424291633194186662080095093570025917938800079226639565593765455331328n,
        "i256": -57896044618658097711785492504343953926634992332820282019728792003956564819968n,
        "i32": -2147483648,
        "i40": -549755813888n,
        "i48": -140737488355328n,
        "i56": -36028797018963968n,
        "i64": -9223372036854775808n,
        "i72": -2361183241434822606848n,
        "i8": -128,
        "i80": -604462909807314587353088n,
        "i88": -154742504910672534362390528n,
        "i96": -39614081257132168796771975168n,
        "id": 1,
        "intDefault": -57896044618658097711785492504343953926634992332820282019728792003956564819968n,
        "u104": 0n,
        "u112": 0n,
        "u120": 0n,
        "u128": 0n,
        "u136": 0n,
        "u144": 0n,
        "u152": 0n,
        "u16": 0,
        "u160": 0n,
        "u168": 0n,
        "u176": 0n,
        "u184": 0n,
        "u192": 0n,
        "u200": 0n,
        "u208": 0n,
        "u216": 0n,
        "u224": 0n,
        "u232": 0n,
        "u24": 0,
        "u240": 0n,
        "u248": 0n,
        "u256": 0n,
        "u32": 0n,
        "u40": 0n,
        "u48": 0n,
        "u56": 0n,
        "u64": 0n,
        "u72": 0n,
        "u8": 0,
        "u80": 0n,
        "u88": 0n,
        "u96": 0n,
        "uintDefault": 0n,
      },
    ]
  `);
});

test("integer values accept number, bigint, and decimal string input", () => {
  const params = AbiParameters.from([
    "uint8 small",
    "int32 medium",
    "uint32 wide",
    "int64 large",
    "uint256 huge",
  ]);

  expect([
    abiParametersToValues(params, [7, -7, 7, -7, 7]),
    abiParametersToValues(params, [7n, -7n, 7n, -7n, 7n]),
    abiParametersToValues(params, ["7", "-7", "7", "-7", "7"]),
  ]).toMatchInlineSnapshot(`
    [
      {
        "huge": 7n,
        "large": -7n,
        "medium": -7,
        "small": 7,
        "wide": 7n,
      },
      {
        "huge": 7n,
        "large": -7n,
        "medium": -7,
        "small": 7,
        "wide": 7n,
      },
      {
        "huge": 7n,
        "large": -7n,
        "medium": -7,
        "small": 7,
        "wide": 7n,
      },
    ]
  `);
});

test("fixed-size bytes of every width map to char columns and round-trip", async () => {
  const row = Array.from(
    { length: 32 },
    (_, index) => `0x${"aB".repeat(index + 1)}`,
  );

  const { ddl, selected } = await roundTrip(BYTES_PARAMS, [row]);

  expect(ddl).toMatchInlineSnapshot(`
    "CREATE TABLE "mutation" (
    	"id" integer PRIMARY KEY NOT NULL,
    	"b1" char(4) NOT NULL,
    	"b2" char(6) NOT NULL,
    	"b3" char(8) NOT NULL,
    	"b4" char(10) NOT NULL,
    	"b5" char(12) NOT NULL,
    	"b6" char(14) NOT NULL,
    	"b7" char(16) NOT NULL,
    	"b8" char(18) NOT NULL,
    	"b9" char(20) NOT NULL,
    	"b10" char(22) NOT NULL,
    	"b11" char(24) NOT NULL,
    	"b12" char(26) NOT NULL,
    	"b13" char(28) NOT NULL,
    	"b14" char(30) NOT NULL,
    	"b15" char(32) NOT NULL,
    	"b16" char(34) NOT NULL,
    	"b17" char(36) NOT NULL,
    	"b18" char(38) NOT NULL,
    	"b19" char(40) NOT NULL,
    	"b20" char(42) NOT NULL,
    	"b21" char(44) NOT NULL,
    	"b22" char(46) NOT NULL,
    	"b23" char(48) NOT NULL,
    	"b24" char(50) NOT NULL,
    	"b25" char(52) NOT NULL,
    	"b26" char(54) NOT NULL,
    	"b27" char(56) NOT NULL,
    	"b28" char(58) NOT NULL,
    	"b29" char(60) NOT NULL,
    	"b30" char(62) NOT NULL,
    	"b31" char(64) NOT NULL,
    	"b32" char(66) NOT NULL
    );
    "
  `);
  expect(selected).toMatchInlineSnapshot(`
    [
      {
        "b1": "0xab",
        "b10": "0xabababababababababab",
        "b11": "0xababababababababababab",
        "b12": "0xabababababababababababab",
        "b13": "0xababababababababababababab",
        "b14": "0xabababababababababababababab",
        "b15": "0xababababababababababababababab",
        "b16": "0xabababababababababababababababab",
        "b17": "0xababababababababababababababababab",
        "b18": "0xabababababababababababababababababab",
        "b19": "0xababababababababababababababababababab",
        "b2": "0xabab",
        "b20": "0xabababababababababababababababababababab",
        "b21": "0xababababababababababababababababababababab",
        "b22": "0xabababababababababababababababababababababab",
        "b23": "0xababababababababababababababababababababababab",
        "b24": "0xabababababababababababababababababababababababab",
        "b25": "0xababababababababababababababababababababababababab",
        "b26": "0xabababababababababababababababababababababababababab",
        "b27": "0xababababababababababababababababababababababababababab",
        "b28": "0xabababababababababababababababababababababababababababab",
        "b29": "0xababababababababababababababababababababababababababababab",
        "b3": "0xababab",
        "b30": "0xabababababababababababababababababababababababababababababab",
        "b31": "0xababababababababababababababababababababababababababababababab",
        "b32": "0xabababababababababababababababababababababababababababababababab",
        "b4": "0xabababab",
        "b5": "0xababababab",
        "b6": "0xabababababab",
        "b7": "0xababababababab",
        "b8": "0xabababababababab",
        "b9": "0xababababababababab",
        "id": 0,
      },
    ]
  `);
});

test("scalar ABI types map to columns and round-trip", async () => {
  const params = AbiParameters.from([
    "bool flag",
    "address account",
    "bytes data",
    "string memo",
    "function callback",
  ]);
  const table = createMutationTable(params);

  const { ddl, selected } = await roundTrip(params, [
    [
      true,
      "0x00000000000000000000000000000000000000Ab",
      "0xDEADbeef",
      "hello",
      `0x${"Ab".repeat(24)}`,
    ],
    [false, `0x${"00".repeat(20)}`, "0x", "", `0x${"00".repeat(24)}`],
  ]);

  expect(ddl).toMatchInlineSnapshot(`
    "CREATE TABLE "mutation" (
    	"id" integer PRIMARY KEY NOT NULL,
    	"flag" boolean NOT NULL,
    	"account" char(42) NOT NULL,
    	"data" text NOT NULL,
    	"memo" text NOT NULL,
    	"callback" char(50) NOT NULL
    );
    "
  `);
  expect(selected).toMatchInlineSnapshot(`
    [
      {
        "account": "0x00000000000000000000000000000000000000ab",
        "callback": "0xabababababababababababababababababababababababab",
        "data": "0xdeadbeef",
        "flag": true,
        "id": 0,
        "memo": "hello",
      },
      {
        "account": "0x0000000000000000000000000000000000000000",
        "callback": "0x000000000000000000000000000000000000000000000000",
        "data": "0x",
        "flag": false,
        "id": 1,
        "memo": "",
      },
    ]
  `);
  expectTypeOf<Omit<typeof table.$inferInsert, "id">>().toEqualTypeOf<{
    flag: boolean;
    account: Hex;
    data: Hex;
    memo: string;
    callback: Hex;
  }>();
});

test("hex values are stored lowercase at the top level and inside jsonb", () => {
  const params = AbiParameters.from([
    "address account",
    "bytes data",
    "bytes32 key",
    "function callback",
    "address[] accounts",
    "(address account, bytes4 selector, string memo) order",
  ]);

  expect(
    abiParametersToValues(params, [
      "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed",
      "0xABCDEF",
      `0x${"AB".repeat(32)}`,
      `0x${"CD".repeat(24)}`,
      ["0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed"],
      {
        account: "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed",
        selector: "0xA9059CBB",
        memo: "0xABCD is a string, not hex",
      },
    ]),
  ).toMatchInlineSnapshot(`
    {
      "account": "0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed",
      "accounts": [
        "0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed",
      ],
      "callback": "0xcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd",
      "data": "0xabcdef",
      "key": "0xabababababababababababababababababababababababababababababababab",
      "order": {
        "account": "0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed",
        "memo": "0xABCD is a string, not hex",
        "selector": "0xa9059cbb",
      },
    }
  `);
});

test("strings with NUL or lone surrogates are stored with U+FFFD", async () => {
  const params = AbiParameters.from([
    "string memo",
    "string[] memos",
    "(string memo, uint8 count) note",
  ]);

  const { selected } = await roundTrip(params, [
    [
      "a\u0000b\uD800c",
      ["\u0000", "\uDC00", "ok"],
      { memo: "x\u0000y\uD83D", count: 1 },
    ],
  ]);

  expect(selected).toMatchInlineSnapshot(`
    [
      {
        "id": 0,
        "memo": "a�b�c",
        "memos": [
          "�",
          "�",
          "ok",
        ],
        "note": {
          "count": 1,
          "memo": "x�y�",
        },
      },
    ]
  `);
});

test("named tuples give the same jsonb from object or positional input", () => {
  const params = AbiParameters.from([
    "(uint256 amount, (address account, bool ok) maker) order",
  ]);
  const fromObject = abiParametersToValues(params, [
    {
      amount: 5n,
      maker: {
        account: "0x00000000000000000000000000000000000000Ab",
        ok: true,
      },
    },
  ]);
  const fromArray = abiParametersToValues(params, [
    [5n, ["0x00000000000000000000000000000000000000Ab", true]],
  ]);

  expect(fromArray).toEqual(fromObject);
  expect(fromObject).toMatchInlineSnapshot(`
    {
      "order": {
        "amount": "5",
        "maker": {
          "account": "0x00000000000000000000000000000000000000ab",
          "ok": true,
        },
      },
    }
  `);
});

test("tuples with an unnamed component stay positional", () => {
  const params = AbiParameters.from(["(uint256, address account) pair"]);

  expect(
    abiParametersToValues(params, [
      [5n, "0x00000000000000000000000000000000000000Ab"],
    ]),
  ).toMatchInlineSnapshot(`
    {
      "pair": [
        "5",
        "0x00000000000000000000000000000000000000ab",
      ],
    }
  `);
});

test("integers inside jsonb are numbers up to 48 bits and decimal strings above", () => {
  const params = AbiParameters.from([
    "(uint8 u8, uint48 u48, uint56 u56, int48 i48, int56 i56, uint256 u256) widths",
  ]);
  const table = createMutationTable(params);

  expect([
    abiParametersToValues(params, [[1, 2, 3, -4, -5, 6]]),
    abiParametersToValues(params, [[1n, 2n, 3n, -4n, -5n, 6n]]),
  ]).toMatchInlineSnapshot(`
    [
      {
        "widths": {
          "i48": -4,
          "i56": "-5",
          "u256": "6",
          "u48": 2,
          "u56": "3",
          "u8": 1,
        },
      },
      {
        "widths": {
          "i48": -4,
          "i56": "-5",
          "u256": "6",
          "u48": 2,
          "u56": "3",
          "u8": 1,
        },
      },
    ]
  `);
  expectTypeOf<typeof table.$inferInsert.widths>().toEqualTypeOf<{
    readonly u8: number;
    readonly u48: number;
    readonly u56: string;
    readonly i48: number;
    readonly i56: string;
    readonly u256: string;
  }>();
});

test("arrays and tuples map to jsonb and round-trip", async () => {
  const params = AbiParameters.from([
    "uint256[] amounts",
    "uint64[2][] matrix",
    "bool[3] flags",
    "(address account, uint256 amount, bool[] flags) order",
    "(uint64 quantity, uint64 price, (address account, uint256 nonce) maker)[] fills",
  ]);
  const table = createMutationTable(params);

  const { ddl, selected } = await roundTrip(params, [
    [
      [1n, 2n],
      [
        [3n, 4n],
        [5n, 6n],
      ],
      [true, false, true],
      {
        account: "0x0000000000000000000000000000000000000001",
        amount: 7n,
        flags: [true, false],
      },
      [
        {
          quantity: 8n,
          price: 9n,
          maker: {
            account: "0x0000000000000000000000000000000000000002",
            nonce: 10n,
          },
        },
      ],
    ],
    [[], [], [false, false, false], [`0x${"00".repeat(20)}`, 0n, []], []],
  ]);

  expect(ddl).toMatchInlineSnapshot(`
    "CREATE TABLE "mutation" (
    	"id" integer PRIMARY KEY NOT NULL,
    	"amounts" jsonb NOT NULL,
    	"matrix" jsonb NOT NULL,
    	"flags" jsonb NOT NULL,
    	"order" jsonb NOT NULL,
    	"fills" jsonb NOT NULL
    );
    "
  `);
  expect(selected).toMatchInlineSnapshot(`
    [
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
        "flags": [
          true,
          false,
          true,
        ],
        "id": 0,
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
      },
      {
        "amounts": [],
        "fills": [],
        "flags": [
          false,
          false,
          false,
        ],
        "id": 1,
        "matrix": [],
        "order": {
          "account": "0x0000000000000000000000000000000000000000",
          "amount": "0",
          "flags": [],
        },
      },
    ]
  `);
  expectTypeOf<Omit<typeof table.$inferInsert, "id">>().toEqualTypeOf<{
    amounts: readonly string[];
    matrix: readonly (readonly string[])[];
    flags: readonly boolean[];
    order: {
      readonly account: Hex;
      readonly amount: string;
      readonly flags: readonly boolean[];
    };
    fills: readonly {
      readonly quantity: string;
      readonly price: string;
      readonly maker: { readonly account: Hex; readonly nonce: string };
    }[];
  }>();
});

test("values by name and by position give the same row", () => {
  const params = [
    ...AbiParameters.from(["uint256 amount", "address account"]),
    { type: "bool" },
  ] as const;

  const byPosition = abiParametersToValues(params, [
    1n,
    "0x00000000000000000000000000000000000000Ab",
    true,
  ]);
  const byName = abiParametersToValues(params, {
    amount: 1n,
    account: "0x00000000000000000000000000000000000000Ab",
    arg2: true,
  });

  expect(byName).toEqual(byPosition);
  expect(byPosition).toMatchInlineSnapshot(`
    {
      "account": "0x00000000000000000000000000000000000000ab",
      "amount": 1n,
      "arg2": true,
    }
  `);
});

test("exported column types match the built columns", () => {
  const params = AbiParameters.from([
    "uint256 amount",
    "address account",
    "(uint8 count) note",
  ]);
  type Many = AbiParametersToColumns<typeof params>;

  expectTypeOf<AbiParameterToColumn<(typeof params)[0]>>().toEqualTypeOf<
    Many["amount"]
  >();
  expectTypeOf(abiParametersToColumns(params)).toEqualTypeOf<Many>();
  expectTypeOf<
    AbiParameterToColumn<{ type: "fixed128x18"; name: "price" }>
  >().toBeNever();
});
