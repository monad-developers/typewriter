import { expect, test } from "bun:test";
import { complexLayout, layout, OWNER } from "../test/utils";
import { keccakSlot } from "./solidity-encoding";
import { resolveStoragePath, type StorageLayout } from "./storage-layout";
import { parseStoragePath } from "./storage-path";

function resolve(storageLayout: StorageLayout, path: string) {
  const location = resolveStoragePath(storageLayout, parseStoragePath(path));
  return {
    slot: location.slot,
    offset: location.offset,
    type: location.type.label,
  };
}

test("resolveStoragePath resolves top-level and packed values", () => {
  expect([
    resolve(layout, "totalSupply"),
    resolve(layout, "owner"),
    resolve(layout, "paused"),
  ]).toMatchInlineSnapshot(`
    [
      {
        "offset": 0,
        "slot": 0n,
        "type": "uint256",
      },
      {
        "offset": 0,
        "slot": 1n,
        "type": "address",
      },
      {
        "offset": 20,
        "slot": 1n,
        "type": "bool",
      },
    ]
  `);
});

test("resolveStoragePath resolves struct fields", () => {
  expect([
    resolve(layout, "metadata"),
    resolve(layout, "metadata.active"),
    resolve(layout, "metadata.admin"),
    resolve(layout, "metadata.inner.count"),
  ]).toMatchInlineSnapshot(`
    [
      {
        "offset": 0,
        "slot": 4n,
        "type": "struct Test.Metadata",
      },
      {
        "offset": 8,
        "slot": 4n,
        "type": "bool",
      },
      {
        "offset": 0,
        "slot": 5n,
        "type": "address",
      },
      {
        "offset": 0,
        "slot": 6n,
        "type": "uint256",
      },
    ]
  `);
});

test("resolveStoragePath packs fixed array value elements", () => {
  expect([
    resolve(layout, "fixedNumbers"),
    resolve(layout, "fixedNumbers[1]"),
    resolve(layout, "fixedNumbers[2]"),
  ]).toMatchInlineSnapshot(`
    [
      {
        "offset": 0,
        "slot": 8n,
        "type": "uint128[3]",
      },
      {
        "offset": 16,
        "slot": 8n,
        "type": "uint128",
      },
      {
        "offset": 0,
        "slot": 9n,
        "type": "uint128",
      },
    ]
  `);
});

test("resolveStoragePath resolves dynamic array elements from keccak256(slot)", () => {
  expect(resolve(layout, "dynamicNumbers")).toEqual({
    slot: 10n,
    offset: 0,
    type: "uint256[]",
  });
  expect(resolve(layout, "dynamicNumbers[1]")).toEqual({
    slot: keccakSlot(10n) + 1n,
    offset: 0,
    type: "uint256",
  });
});

test("resolveStoragePath resolves bytes and strings to their root slot", () => {
  expect([
    resolve(layout, "rawBytes"),
    resolve(layout, "message"),
  ]).toMatchInlineSnapshot(`
    [
      {
        "offset": 0,
        "slot": 11n,
        "type": "bytes",
      },
      {
        "offset": 0,
        "slot": 12n,
        "type": "string",
      },
    ]
  `);
});

test("resolveStoragePath hashes mapping keys with the mapping slot", () => {
  expect([
    resolve(layout, "balances"),
    resolve(layout, `balances[${OWNER}]`),
  ]).toMatchInlineSnapshot(`
    [
      {
        "offset": 0,
        "slot": 7n,
        "type": "mapping(address => uint256)",
      },
      {
        "offset": 0,
        "slot": 49388279509293316078577064985078118302854491611548467545929961713850579549116n,
        "type": "uint256",
      },
    ]
  `);
});

test("resolveStoragePath resolves nested composites", () => {
  expect([
    resolve(complexLayout, "orders[1].amount"),
    resolve(complexLayout, "book.priceLevels[1]"),
    resolve(complexLayout, "book.inner.count"),
    resolve(complexLayout, "matrix[1][0]"),
    resolve(complexLayout, "matrix[1][1]"),
  ]).toMatchInlineSnapshot(`
    [
      {
        "offset": 0,
        "slot": 3n,
        "type": "uint256",
      },
      {
        "offset": 16,
        "slot": 10n,
        "type": "uint128",
      },
      {
        "offset": 0,
        "slot": 11n,
        "type": "uint256",
      },
      {
        "offset": 0,
        "slot": 21n,
        "type": "uint128",
      },
      {
        "offset": 16,
        "slot": 21n,
        "type": "uint128",
      },
    ]
  `);
});

test("resolveStoragePath accepts hex and negative integer subscripts", () => {
  const intKeyLayout = {
    storage: [
      {
        astId: 1,
        contract: "src/Test.sol:Test",
        label: "debts",
        offset: 0,
        slot: "0",
        type: "t_mapping(t_int8,t_uint256)",
      },
    ],
    types: {
      t_int8: { encoding: "inplace", label: "int8", numberOfBytes: "1" },
      t_uint256: { encoding: "inplace", label: "uint256", numberOfBytes: "32" },
      "t_mapping(t_int8,t_uint256)": {
        encoding: "mapping",
        key: "t_int8",
        label: "mapping(int8 => uint256)",
        numberOfBytes: "32",
        value: "t_uint256",
      },
    },
  } as const satisfies StorageLayout;

  expect(resolve(layout, "fixedNumbers[0x1]")).toEqual(
    resolve(layout, "fixedNumbers[1]"),
  );
  expect(resolve(intKeyLayout, "debts[-1]").slot).not.toBe(
    resolve(intKeyLayout, "debts[1]").slot,
  );
  expect(() => resolve(intKeyLayout, "debts[128]")).toThrow(
    "mapping key for 'debts' must be within the int8 range -128 to 127",
  );
});

test("resolveStoragePath rejects invalid paths", () => {
  expect(() => resolve(layout, "missing")).toThrow(
    "storage variable not found: missing",
  );
  expect(() => resolve(layout, "metadata.missing")).toThrow(
    "struct field not found: metadata.missing",
  );
  expect(() => resolve(layout, "totalSupply.field")).toThrow(
    "storage path field 'field' requires a struct: totalSupply",
  );
  expect(() => resolve(layout, "metadata[0]")).toThrow(
    "storage path subscript requires an array or mapping: metadata[0]",
  );
  expect(() => resolve(layout, "balances[0x1234]")).toThrow(
    "mapping key for 'balances' must be 20 bytes",
  );
  expect(() => resolve(layout, "balances[1]")).toThrow(
    "mapping key for 'balances' must be an address hex string",
  );
  expect(() => resolve(layout, "fixedNumbers[3]")).toThrow(
    "fixed array index out of bounds: fixedNumbers[3]",
  );
  expect(() => resolve(layout, "dynamicNumbers[-1]")).toThrow(
    "dynamic array index out of bounds: dynamicNumbers[-1]",
  );
  expect(() => resolve(layout, "dynamicNumbers[true]")).toThrow(
    "dynamic array index must be a number: dynamicNumbers[true]",
  );
});
