import { expect, test } from "bun:test";
import {
  decodeStorage,
  encodeStorage,
  formatStoragePath,
  getStaticStoragePaths,
  getStoragePath,
  getStorageSlot,
  type HexString,
  parseStoragePath,
  type StorageLayout,
} from "./index";

const OWNER = "0x1111111111111111111111111111111111111234" as const;
const PACKED_OWNER_PAUSED =
  `0x${"00".repeat(11)}01${OWNER.slice(2)}` as HexString;
const PACKED_OWNER_UNPAUSED =
  `0x${"00".repeat(12)}${OWNER.slice(2)}` as HexString;
const SALT = `0x${"ff".repeat(32)}` as HexString;

const layout = {
  storage: [
    {
      astId: 1,
      contract: "src/Test.sol:Test",
      label: "totalSupply",
      offset: 0,
      slot: "0",
      type: "t_uint256",
    },
    {
      astId: 2,
      contract: "src/Test.sol:Test",
      label: "owner",
      offset: 0,
      slot: "1",
      type: "t_address",
    },
    {
      astId: 3,
      contract: "src/Test.sol:Test",
      label: "paused",
      offset: 20,
      slot: "1",
      type: "t_bool",
    },
    {
      astId: 4,
      contract: "src/Test.sol:Test",
      label: "debt",
      offset: 0,
      slot: "2",
      type: "t_int16",
    },
    {
      astId: 5,
      contract: "src/Test.sol:Test",
      label: "salt",
      offset: 0,
      slot: "3",
      type: "t_bytes32",
    },
    {
      astId: 6,
      contract: "src/Test.sol:Test",
      label: "balances",
      offset: 0,
      slot: "4",
      type: "t_mapping(t_address,t_uint256)",
    },
  ],
  types: {
    t_address: {
      encoding: "inplace",
      label: "address",
      numberOfBytes: "20",
    },
    t_bool: {
      encoding: "inplace",
      label: "bool",
      numberOfBytes: "1",
    },
    t_bytes32: {
      encoding: "inplace",
      label: "bytes32",
      numberOfBytes: "32",
    },
    t_int16: {
      encoding: "inplace",
      label: "int16",
      numberOfBytes: "2",
    },
    "t_mapping(t_address,t_uint256)": {
      encoding: "mapping",
      key: "t_address",
      label: "mapping(address => uint256)",
      numberOfBytes: "32",
      value: "t_uint256",
    },
    t_uint256: {
      encoding: "inplace",
      label: "uint256",
      numberOfBytes: "32",
    },
  },
} as const satisfies StorageLayout;

test("parseStoragePath round-trips human-readable paths", () => {
  const path = parseStoragePath(
    'accounts[0xabcd].orders[3].metadata["lastUpdate"]',
  );

  expect(path).toMatchInlineSnapshot(`
    {
      "root": "accounts",
      "segments": [
        {
          "kind": "subscript",
          "value": {
            "kind": "hex",
            "value": "0xabcd",
          },
        },
        {
          "kind": "field",
          "name": "orders",
        },
        {
          "kind": "subscript",
          "value": {
            "kind": "number",
            "value": 3n,
          },
        },
        {
          "kind": "field",
          "name": "metadata",
        },
        {
          "kind": "subscript",
          "value": {
            "kind": "string",
            "value": "lastUpdate",
          },
        },
      ],
    }
  `);
  expect(formatStoragePath(path)).toBe(
    'accounts[0xabcd].orders[3].metadata["lastUpdate"]',
  );
});

test("getStorageSlot resolves top-level value types", () => {
  expect(getStorageSlot(layout, "owner")).toMatchInlineSnapshot(`
    [
      {
        "numberOfBytes": 20,
        "offset": 0,
        "path": {
          "root": "owner",
          "segments": [],
        },
        "slot": "0x0000000000000000000000000000000000000000000000000000000000000001",
        "type": "address",
      },
    ]
  `);
  expect(getStorageSlot(layout, "paused")).toMatchInlineSnapshot(`
    [
      {
        "numberOfBytes": 1,
        "offset": 20,
        "path": {
          "root": "paused",
          "segments": [],
        },
        "slot": "0x0000000000000000000000000000000000000000000000000000000000000001",
        "type": "bool",
      },
    ]
  `);
});

test("getStoragePath maps changed slots to generated static paths", () => {
  expect(
    getStoragePath(layout, ["0x1"]).map(formatStoragePath),
  ).toMatchInlineSnapshot(`
      [
        "owner",
        "paused",
      ]
    `);
});

test("getStoragePath accepts explicit known paths", () => {
  expect(
    getStoragePath(layout, ["0x1"], { knownPaths: ["paused"] }).map(
      formatStoragePath,
    ),
  ).toMatchInlineSnapshot(`
    [
      "paused",
    ]
  `);
});

test("getStaticStoragePaths omits mappings", () => {
  expect(
    getStaticStoragePaths(layout).map(formatStoragePath),
  ).toMatchInlineSnapshot(`
      [
        "totalSupply",
        "owner",
        "paused",
        "debt",
        "salt",
      ]
    `);
});

test("decodeStorage decodes value types from raw slots", () => {
  const storage = {
    "0x0": "0x2a",
    "0x1": PACKED_OWNER_PAUSED,
    "0x2": "0xffff",
    "0x3": SALT,
  } as const;

  expect(decodeStorage(layout, "totalSupply", storage)).toBe(42n);
  expect(decodeStorage(layout, "owner", storage)).toBe(OWNER);
  expect(decodeStorage(layout, "paused", storage)).toBe(true);
  expect(decodeStorage(layout, "debt", storage)).toBe(-1);
  expect(decodeStorage(layout, "salt", storage)).toBe(SALT);
});

test("encodeStorage encodes full-slot value types", () => {
  expect(encodeStorage(layout, "totalSupply", 42n)).toMatchInlineSnapshot(`
    [
      {
        "slot": "0x0000000000000000000000000000000000000000000000000000000000000000",
        "value": "0x000000000000000000000000000000000000000000000000000000000000002a",
      },
    ]
  `);
  expect(encodeStorage(layout, "salt", SALT)).toEqual([
    {
      slot: "0x0000000000000000000000000000000000000000000000000000000000000003",
      value: SALT,
    },
  ]);
});

test("encodeStorage preserves neighboring bytes for packed values", () => {
  const storage = {
    "0x1": PACKED_OWNER_PAUSED,
  } as const;

  expect(encodeStorage(layout, "paused", false, storage)).toEqual([
    {
      slot: "0x0000000000000000000000000000000000000000000000000000000000000001",
      value: PACKED_OWNER_UNPAUSED,
    },
  ]);
});

test("encodeStorage requires existing slots for packed values", () => {
  expect(() => encodeStorage(layout, "paused", false)).toThrow(
    "existing storage value is required to encode packed path: paused",
  );
});

test("nested and dynamic paths fail explicitly until implemented", () => {
  expect(() => getStorageSlot(layout, "balances[0x1234]")).toThrow(
    "nested storage paths are not supported yet: balances[0x1234]",
  );
  expect(() => getStorageSlot(layout, "balances")).toThrow(
    "unsupported storage path type 'mapping(address => uint256)' for balances",
  );
});
