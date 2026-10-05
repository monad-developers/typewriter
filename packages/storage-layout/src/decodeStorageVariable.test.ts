import { expect, test } from "bun:test";
import { Hex } from "ox";
import {
  bytesStorage,
  layout,
  METADATA_PACKED,
  OWNER,
  PACKED_FIXED_NUMBERS,
  PACKED_OWNER_PAUSED,
  SALT,
  SPENDER,
  slotOf,
} from "../test/utils";
import { MAX_BYTES_LENGTH } from "./decodeStorageVariable";
import { decodeStorageVariable, type StorageLayout } from "./index";

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

test("decodeStorageVariable checksums addresses and keeps other hex lowercase", () => {
  const address = `0x${"ab".repeat(20)}` as const;

  expect(
    decodeStorageVariable(layout, "owner", {
      [slotOf(layout, "owner")]: Hex.padLeft(address, 32),
    }),
  ).toBe("0xABaBaBaBABabABabAbAbABAbABabababaBaBABaB");
  expect(
    decodeStorageVariable(layout, "salt", {
      [slotOf(layout, "salt")]: `0x${"AB".repeat(32)}`,
    }),
  ).toBe(`0x${"ab".repeat(32)}`);
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
    [slotOf(layout, "dynamicNumbers")]: "0x2",
    [slotOf(layout, "dynamicNumbers[0]")]: "0x1",
    [slotOf(layout, "dynamicNumbers[1]")]: "0x2",
  } as const;

  expect(decodeStorageVariable(layout, "dynamicNumbers[1]", storage)).toBe(2n);
});

test("decodeStorageVariable decodes keyed mappings", () => {
  const storage = {
    [slotOf(layout, `balances[${OWNER}]`)]: "0x2a",
    [slotOf(layout, `allowances[${OWNER}][${SPENDER}]`)]: "0x64",
  } as const;

  expect(decodeStorageVariable(layout, `balances[${OWNER}]`, storage)).toBe(
    42n,
  );
  expect(
    decodeStorageVariable(layout, `allowances[${OWNER}][${SPENDER}]`, storage),
  ).toBe(100n);
});

test("decodeStorageVariable decodes short in-slot bytes and string", () => {
  const storage = {
    ...bytesStorage(slotOf(layout, "rawBytes"), "0x1234"),
    ...bytesStorage(slotOf(layout, "message"), Hex.fromString("hello")),
  };

  expect(decodeStorageVariable(layout, "rawBytes", storage)).toBe("0x1234");
  expect(decodeStorageVariable(layout, "message", storage)).toBe("hello");
});

test("decodeStorageVariable decodes long out-of-slot bytes and string", () => {
  const longBytes = `0x${"11".repeat(33)}` as const;
  const longString = "x".repeat(33);
  const storage = {
    ...bytesStorage(slotOf(layout, "rawBytes"), longBytes),
    ...bytesStorage(slotOf(layout, "message"), Hex.fromString(longString)),
  };

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
  const rootSlot = slotOf(layout, "totalSupply");

  expect(() => decodeStorageVariable(layout, "totalSupply", {})).toThrow(
    `storage value not found for slot: ${rootSlot}`,
  );
});

test("decodeStorageVariable requires bytes and string root slots", () => {
  const longBytes = `0x${"11".repeat(33)}` as const;
  const longString = "x".repeat(33);
  const rawBytesStorage = bytesStorage(slotOf(layout, "rawBytes"), longBytes);
  const stringStorage = bytesStorage(
    slotOf(layout, "message"),
    Hex.fromString(longString),
  );
  const rawBytesRootSlot = slotOf(layout, "rawBytes");
  const stringRootSlot = slotOf(layout, "message");

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
  const rawBytesStorage = bytesStorage(slotOf(layout, "rawBytes"), longBytes);
  const stringStorage = bytesStorage(
    slotOf(layout, "message"),
    Hex.fromString(longString),
  );
  const rawBytesRootSlot = slotOf(layout, "rawBytes");
  const stringRootSlot = slotOf(layout, "message");
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

test("decodeStorageVariable matches slot keys in any hex form", () => {
  const slot = slotOf(layout, `balances[${OWNER}]`);

  expect(
    decodeStorageVariable(layout, `balances[${OWNER}]`, {
      [slot.toUpperCase().replace("0X", "0x") as Hex.Hex]: "0x2a",
    }),
  ).toBe(42n);
  expect(decodeStorageVariable(layout, "totalSupply", { "0x00": "0x2a" })).toBe(
    42n,
  );
});

test("decodeStorageVariable decodes empty bytes and string", () => {
  const storage = {
    [slotOf(layout, "rawBytes")]: "0x0",
    [slotOf(layout, "message")]: "0x0",
  } as const;

  expect(decodeStorageVariable(layout, "rawBytes", storage)).toBe("0x");
  expect(decodeStorageVariable(layout, "message", storage)).toBe("");
});

test("decodeStorageVariable decodes 32-byte bytes in the long form", () => {
  const value = `0x${"ab".repeat(32)}` as const;
  const storage = bytesStorage(slotOf(layout, "rawBytes"), value);

  expect(Object.keys(storage)).toHaveLength(2);
  expect(decodeStorageVariable(layout, "rawBytes", storage)).toBe(value);
});

test("decodeStorageVariable rejects bytes root words that Solidity rejects", () => {
  const slot = slotOf(layout, "message");
  // Long form (lowest bit 1) with a length below 32: Solidity panics 0x22.
  expect(() =>
    decodeStorageVariable(layout, "message", { [slot]: "0x3f" }),
  ).toThrow("incorrectly encoded bytes length slot: message");
  // Short form (lowest bit 0) with a length of 32 or more: Solidity panics 0x22.
  expect(() =>
    decodeStorageVariable(layout, "message", { [slot]: "0x40" }),
  ).toThrow("incorrectly encoded bytes length slot: message");
});

test("decodeStorageVariable rejects bytes longer than MAX_BYTES_LENGTH", () => {
  const slot = slotOf(layout, "rawBytes");
  const tooLong = Hex.fromNumber(BigInt(MAX_BYTES_LENGTH + 1) * 2n + 1n, {
    size: 32,
  });

  expect(() =>
    decodeStorageVariable(layout, "rawBytes", { [slot]: tooLong }),
  ).toThrow(
    `bytes value of ${MAX_BYTES_LENGTH + 1} bytes is larger than the ${MAX_BYTES_LENGTH}-byte limit: rawBytes`,
  );
  expect(() =>
    decodeStorageVariable(layout, "rawBytes", {
      [slot]: `0x${"ff".repeat(32)}`,
    }),
  ).toThrow("is larger than the");
});

test("decodeStorageVariable rejects slot values larger than 32 bytes", () => {
  expect(() =>
    decodeStorageVariable(layout, "totalSupply", {
      "0x0": `0x01${"00".repeat(32)}`,
    }),
  ).toThrow("storage value is larger than 32 bytes");
});

test("decodeStorageVariable rejects slot keys that are not hex", () => {
  expect(() =>
    decodeStorageVariable(layout, "totalSupply", {
      ["slot0" as Hex.Hex]: "0x2a",
    }),
  ).toThrow("storage slot key is not a hex string: slot0");
});
