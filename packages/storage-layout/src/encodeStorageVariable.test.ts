import { expect, test } from "bun:test";
import { layout, OWNER, PACKED_OWNER_PAUSED, SALT } from "../test/utils";
import {
  applySlotWrite,
  encodeStorageVariable,
  type SlotWrites,
  type StorageLayout,
} from "./index";

const encodeUnknownStorageVariable = encodeStorageVariable as unknown as (
  layout: StorageLayout,
  variable: string,
  value: unknown,
) => SlotWrites;

test("encodeStorageVariable encodes full-slot value types", () => {
  expect(
    encodeStorageVariable(layout, "totalSupply", 42n),
  ).toMatchInlineSnapshot(`
    {
      "0x0000000000000000000000000000000000000000000000000000000000000000": {
        "mask": "0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
        "value": "0x000000000000000000000000000000000000000000000000000000000000002a",
      },
    }
  `);
  expect(encodeStorageVariable(layout, "salt", SALT)).toMatchInlineSnapshot(`
    {
      "0x0000000000000000000000000000000000000000000000000000000000000003": {
        "mask": "0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
        "value": "0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
      },
    }
  `);
});

test("encodeStorageVariable returns masks for packed values", () => {
  const writes = encodeStorageVariable(layout, "paused", false);
  expect(writes).toMatchInlineSnapshot(`
    {
      "0x0000000000000000000000000000000000000000000000000000000000000001": {
        "mask": "0x0000000000000000000000ff0000000000000000000000000000000000000000",
        "value": "0x0000000000000000000000000000000000000000000000000000000000000000",
      },
    }
  `);
  expect(
    applySlotWrite(
      writes[
        "0x0000000000000000000000000000000000000000000000000000000000000001"
      ]!,
      PACKED_OWNER_PAUSED,
    ),
  ).toBe("0x0000000000000000000000001111111111111111111111111111111111111234");
});

test("encodeStorageVariable encodes nested struct fields", () => {
  expect(
    encodeStorageVariable(layout, "metadata.active", false),
  ).toMatchInlineSnapshot(`
    {
      "0x0000000000000000000000000000000000000000000000000000000000000004": {
        "mask": "0x0000000000000000000000000000000000000000000000ff0000000000000000",
        "value": "0x0000000000000000000000000000000000000000000000000000000000000000",
      },
    }
  `);
});

test("encodeStorageVariable encodes fixed array elements", () => {
  expect(
    encodeStorageVariable(layout, "fixedNumbers[1]", 3n),
  ).toMatchInlineSnapshot(`
    {
      "0x0000000000000000000000000000000000000000000000000000000000000008": {
        "mask": "0xffffffffffffffffffffffffffffffff00000000000000000000000000000000",
        "value": "0x0000000000000000000000000000000300000000000000000000000000000000",
      },
    }
  `);
});

test("encodeStorageVariable encodes dynamic array elements", () => {
  expect(
    encodeStorageVariable(layout, "dynamicNumbers[1]", 3n),
  ).toMatchInlineSnapshot(`
    {
      "0xc65a7bb8d6351c1cf70c95a316cc6a92839c986682d98bc35f958f4883f9d2a9": {
        "mask": "0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
        "value": "0x0000000000000000000000000000000000000000000000000000000000000003",
      },
    }
  `);
});

test("encodeStorageVariable encodes keyed mappings", () => {
  expect(
    encodeStorageVariable(layout, `balances[${OWNER}]`, 42n),
  ).toMatchInlineSnapshot(`
    {
      "0x6d30c68d4703e3ad11b778e8635b89709aaecadb8bd3f2e0e0cff25a4ee1fbbc": {
        "mask": "0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
        "value": "0x000000000000000000000000000000000000000000000000000000000000002a",
      },
    }
  `);
});

test("encodeStorageVariable encodes short in-slot bytes and string", () => {
  expect(
    encodeStorageVariable(layout, "rawBytes", "0x1234"),
  ).toMatchInlineSnapshot(`
    {
      "0x000000000000000000000000000000000000000000000000000000000000000b": {
        "mask": "0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
        "value": "0x1234000000000000000000000000000000000000000000000000000000000004",
      },
    }
  `);
  expect(
    encodeStorageVariable(layout, "message", "hello"),
  ).toMatchInlineSnapshot(`
    {
      "0x000000000000000000000000000000000000000000000000000000000000000c": {
        "mask": "0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
        "value": "0x68656c6c6f00000000000000000000000000000000000000000000000000000a",
      },
    }
  `);
});

test("encodeStorageVariable encodes long out-of-slot bytes and string", () => {
  expect(
    encodeStorageVariable(layout, "rawBytes", `0x${"11".repeat(33)}`),
  ).toMatchInlineSnapshot(`
    {
      "0x000000000000000000000000000000000000000000000000000000000000000b": {
        "mask": "0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
        "value": "0x0000000000000000000000000000000000000000000000000000000000000043",
      },
      "0x0175b7a638427703f0dbe7bb9bbf987a2551717b34e79f33b5b1008d1fa01db9": {
        "mask": "0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
        "value": "0x1111111111111111111111111111111111111111111111111111111111111111",
      },
      "0x0175b7a638427703f0dbe7bb9bbf987a2551717b34e79f33b5b1008d1fa01dba": {
        "mask": "0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
        "value": "0x1100000000000000000000000000000000000000000000000000000000000000",
      },
    }
  `);
  expect(
    encodeStorageVariable(layout, "message", "x".repeat(33)),
  ).toMatchInlineSnapshot(`
    {
      "0x000000000000000000000000000000000000000000000000000000000000000c": {
        "mask": "0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
        "value": "0x0000000000000000000000000000000000000000000000000000000000000043",
      },
      "0xdf6966c971051c3d54ec59162606531493a51404a002842f56009d7e5cf4a8c7": {
        "mask": "0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
        "value": "0x7878787878787878787878787878787878787878787878787878787878787878",
      },
      "0xdf6966c971051c3d54ec59162606531493a51404a002842f56009d7e5cf4a8c8": {
        "mask": "0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
        "value": "0x7800000000000000000000000000000000000000000000000000000000000000",
      },
    }
  `);
});

test("encodeStorageVariable fails loudly for invalid composite variables", () => {
  expect(() =>
    encodeUnknownStorageVariable(layout, "metadata", {
      active: false,
      admin: OWNER,
      inner: { count: 100n },
      lastUpdate: 43n,
    }),
  ).toThrow("storage path does not point to a leaf value: metadata");
  expect(() =>
    encodeUnknownStorageVariable(layout, "fixedNumbers", [1n, 2n, 3n]),
  ).toThrow("storage path does not point to a leaf value: fixedNumbers");
  expect(() =>
    encodeUnknownStorageVariable(layout, "dynamicNumbers", [1n, 2n]),
  ).toThrow("storage path does not point to a leaf value: dynamicNumbers");
  expect(() => encodeUnknownStorageVariable(layout, "balances", {})).toThrow(
    "mapping storage paths require a key: balances",
  );
});

test("encodeStorageVariable rejects unsupported value and type behavior", () => {
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
    encodeUnknownStorageVariable(layout, "totalSupply", -1n),
  ).toThrow("unsigned integer does not fit in 256 bits");
  expect(() => encodeUnknownStorageVariable(layout, "debt", 32768)).toThrow(
    "signed integer does not fit in 16 bits",
  );
  expect(() => encodeUnknownStorageVariable(layout, "paused", 1)).toThrow(
    "bool value must be a boolean",
  );
  expect(() => encodeUnknownStorageVariable(layout, "owner", "nope")).toThrow(
    "address value must be a hex string",
  );
  expect(() => encodeUnknownStorageVariable(layout, "salt", "0x12")).toThrow(
    "fixed bytes value must be exactly 32 bytes",
  );
  expect(() =>
    encodeUnknownStorageVariable(layout, "rawBytes", "0x123"),
  ).toThrow("bytes value must have an even number of hex digits");
  expect(() => encodeUnknownStorageVariable(layout, "message", 1)).toThrow(
    "string value must be a string",
  );
  expect(() =>
    encodeUnknownStorageVariable(unsupportedLayout, "rate", 1n),
  ).toThrow("unsupported storage path type 'fixed128x18' for rate");
});
