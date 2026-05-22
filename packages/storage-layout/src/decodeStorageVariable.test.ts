import { expect, test } from "bun:test";
import type { Hex } from "ox";
import {
  expectSingleSlot,
  layout,
  METADATA_PACKED,
  OWNER,
  PACKED_FIXED_NUMBERS,
  PACKED_OWNER_PAUSED,
  SALT,
  SPENDER,
  writesToStorage,
} from "../test/utils";
import {
  decodeStorageVariable,
  encodeStorageVariable,
  getStorageSlot,
  type StorageLayout,
} from "./index";

const decodeUnknownStorageVariable = decodeStorageVariable as unknown as (
  layout: StorageLayout,
  variable: string,
  storage: { [slot: Hex.Hex]: Hex.Hex },
) => unknown;

test("decodeStorageVariable decodes value types from raw slots", () => {
  const storage = {
    "0x0": "0x2a",
    "0x2": "0xffff",
    "0x3": SALT,
  } as const;

  expect(decodeStorageVariable(layout, "totalSupply", storage)).toBe(42n);
  expect(decodeStorageVariable(layout, "debt", storage)).toBe(-1);
  expect(decodeStorageVariable(layout, "salt", storage)).toBe(SALT);
});

test("decodeStorageVariable decodes packed values", () => {
  const storage = {
    "0x1": PACKED_OWNER_PAUSED,
    "0x4": METADATA_PACKED,
  } as const;

  expect(decodeStorageVariable(layout, "owner", storage)).toBe(OWNER);
  expect(decodeStorageVariable(layout, "paused", storage)).toBe(true);
  expect(decodeStorageVariable(layout, "metadata.lastUpdate", storage)).toBe(
    42n,
  );
  expect(decodeStorageVariable(layout, "metadata.active", storage)).toBe(true);
});

test("decodeStorageVariable decodes nested struct fields", () => {
  const storage = {
    "0x6": "0x64",
  } as const;

  expect(decodeStorageVariable(layout, "metadata.inner.count", storage)).toBe(
    100n,
  );
});

test("decodeStorageVariable decodes fixed array elements", () => {
  const storage = {
    "0x8": PACKED_FIXED_NUMBERS,
  } as const;

  expect(decodeStorageVariable(layout, "fixedNumbers[0]", storage)).toBe(1n);
  expect(decodeStorageVariable(layout, "fixedNumbers[1]", storage)).toBe(2n);
});

test("decodeStorageVariable decodes dynamic array elements", () => {
  const storage = {
    [expectSingleSlot(getStorageSlot(layout, "dynamicNumbers"))]: "0x2",
    [expectSingleSlot(getStorageSlot(layout, "dynamicNumbers[0]"))]: "0x1",
    [expectSingleSlot(getStorageSlot(layout, "dynamicNumbers[1]"))]: "0x2",
  } as const;

  expect(decodeStorageVariable(layout, "dynamicNumbers[1]", storage)).toBe(2n);
});

test("decodeStorageVariable decodes keyed mappings", () => {
  const storage = {
    [expectSingleSlot(getStorageSlot(layout, `balances[${OWNER}]`))]: "0x2a",
    [expectSingleSlot(
      getStorageSlot(layout, `allowances[${OWNER}][${SPENDER}]`),
    )]: "0x64",
  } as const;

  expect(decodeStorageVariable(layout, `balances[${OWNER}]`, storage)).toBe(
    42n,
  );
  expect(
    decodeStorageVariable(layout, `allowances[${OWNER}][${SPENDER}]`, storage),
  ).toBe(100n);
});

test("decodeStorageVariable decodes short in-slot bytes and string", () => {
  const storage = writesToStorage({
    ...encodeStorageVariable(layout, "rawBytes", "0x1234"),
    ...encodeStorageVariable(layout, "message", "hello"),
  });

  expect(decodeStorageVariable(layout, "rawBytes", storage)).toBe("0x1234");
  expect(decodeStorageVariable(layout, "message", storage)).toBe("hello");
});

test("decodeStorageVariable decodes long out-of-slot bytes and string", () => {
  const longBytes = `0x${"11".repeat(33)}` as const;
  const longString = "x".repeat(33);
  const storage = writesToStorage({
    ...encodeStorageVariable(layout, "rawBytes", longBytes),
    ...encodeStorageVariable(layout, "message", longString),
  });

  expect(decodeStorageVariable(layout, "rawBytes", storage)).toBe(longBytes);
  expect(decodeStorageVariable(layout, "message", storage)).toBe(longString);
});

test("decodeStorageVariable fails loudly for invalid composite variables", () => {
  const storage = {};

  expect(() =>
    decodeUnknownStorageVariable(layout, "metadata", storage),
  ).toThrow("storage path does not point to a leaf value: metadata");
  expect(() =>
    decodeUnknownStorageVariable(layout, "fixedNumbers", storage),
  ).toThrow("storage path does not point to a leaf value: fixedNumbers");
  expect(() =>
    decodeUnknownStorageVariable(layout, "dynamicNumbers", storage),
  ).toThrow("storage path does not point to a leaf value: dynamicNumbers");
  expect(() =>
    decodeUnknownStorageVariable(layout, "balances", storage),
  ).toThrow("mapping storage paths require a key: balances");
  expect(() =>
    decodeUnknownStorageVariable(layout, `allowances[${OWNER}]`, storage),
  ).toThrow(`mapping storage paths require a key: allowances[${OWNER}]`);
});

test("decodeStorageVariable fails loudly when raw slots are missing", () => {
  const rootSlot = expectSingleSlot(getStorageSlot(layout, "totalSupply"));

  expect(() => decodeStorageVariable(layout, "totalSupply", {})).toThrow(
    `storage value not found for slot: ${rootSlot}`,
  );
});

test("decodeStorageVariable requires bytes and string root slots", () => {
  const longBytes = `0x${"11".repeat(33)}` as const;
  const longString = "x".repeat(33);
  const rawBytesStorage = writesToStorage(
    encodeStorageVariable(layout, "rawBytes", longBytes),
  );
  const stringStorage = writesToStorage(
    encodeStorageVariable(layout, "message", longString),
  );
  const rawBytesRootSlot = expectSingleSlot(getStorageSlot(layout, "rawBytes"));
  const stringRootSlot = expectSingleSlot(getStorageSlot(layout, "message"));

  delete rawBytesStorage[rawBytesRootSlot];
  delete stringStorage[stringRootSlot];

  expect(() =>
    decodeStorageVariable(layout, "rawBytes", rawBytesStorage),
  ).toThrow(`storage value not found for slot: ${rawBytesRootSlot}`);
  expect(() => decodeStorageVariable(layout, "message", stringStorage)).toThrow(
    `storage value not found for slot: ${stringRootSlot}`,
  );
});

test("decodeStorageVariable requires bytes and string payload slots", () => {
  const longBytes = `0x${"11".repeat(33)}` as const;
  const longString = "x".repeat(33);
  const rawBytesStorage = writesToStorage(
    encodeStorageVariable(layout, "rawBytes", longBytes),
  );
  const stringStorage = writesToStorage(
    encodeStorageVariable(layout, "message", longString),
  );
  const rawBytesRootSlot = expectSingleSlot(getStorageSlot(layout, "rawBytes"));
  const stringRootSlot = expectSingleSlot(getStorageSlot(layout, "message"));
  const rawBytesPayloadSlot = Object.keys(rawBytesStorage).find(
    (slot) => slot !== rawBytesRootSlot,
  ) as Hex.Hex;
  const stringPayloadSlot = Object.keys(stringStorage).find(
    (slot) => slot !== stringRootSlot,
  ) as Hex.Hex;

  delete rawBytesStorage[rawBytesPayloadSlot];
  delete stringStorage[stringPayloadSlot];

  expect(() =>
    decodeStorageVariable(layout, "rawBytes", rawBytesStorage),
  ).toThrow(`storage value not found for slot: ${rawBytesPayloadSlot}`);
  expect(() => decodeStorageVariable(layout, "message", stringStorage)).toThrow(
    `storage value not found for slot: ${stringPayloadSlot}`,
  );
});

test("decodeStorageVariable rejects unsupported value types", () => {
  const unsupportedLayout = {
    storage: [
      {
        astId: 1,
        contract: "src/Test.sol:Test",
        label: "rate",
        offset: 0,
        slot: "0",
        type: "t_fixed128x18",
      },
    ],
    types: {
      t_fixed128x18: {
        encoding: "inplace",
        label: "fixed128x18",
        numberOfBytes: "16",
      },
    },
  } as const satisfies StorageLayout;

  expect(() =>
    decodeUnknownStorageVariable(unsupportedLayout, "rate", { "0x0": "0x0" }),
  ).toThrow("unsupported storage path type 'fixed128x18' for rate");
});
