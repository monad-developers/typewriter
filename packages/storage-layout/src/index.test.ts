import { expect, test } from "bun:test";
import type { Hex } from "ox";
import {
  complexLayout,
  layout,
  METADATA_PACKED,
  OWNER,
  PACKED_OWNER_PAUSED,
  SALT,
} from "../test/utils";
import {
  applySlotWrite,
  decodeStoragePath,
  encodeStorage,
  encodeStoragePath,
  getStoragePath,
  getStorageSlot,
  type SlotWrites,
  type StorageLayout,
  type StorageLayoutToPrimitiveType,
} from "./index";

const reversibleLayout = {
  ...layout,
  storage: layout.storage.filter(
    (item) => layout.types[item.type]?.encoding !== "mapping",
  ),
} satisfies StorageLayout;

const PACKED_FIXED_NUMBERS =
  "0x0000000000000000000000000000000200000000000000000000000000000001";
const SPENDER = "0x2222222222222222222222222222222222221234" as const;

function writesToStorage(writes: SlotWrites) {
  return Object.fromEntries(
    Object.entries(writes).map(([slot, write]) => [slot, write.value]),
  );
}

function expectSingleSlot(slot: Hex.Hex | Hex.Hex[]): Hex.Hex {
  if (Array.isArray(slot)) {
    throw new Error("expected a single slot");
  }
  return slot;
}

const encodeUnknownStoragePath = encodeStoragePath as unknown as (
  layout: StorageLayout,
  path: string,
  value: unknown,
) => SlotWrites;

const decodeUnknownStoragePath = decodeStoragePath as unknown as (
  layout: StorageLayout,
  path: string,
  storage: { [slot: Hex.Hex]: Hex.Hex },
) => unknown;

test("getStorageSlot resolves top-level value types", () => {
  expect(getStorageSlot(layout, "owner")).toBe(
    "0x0000000000000000000000000000000000000000000000000000000000000001",
  );
  expect(getStorageSlot(layout, "paused")).toBe(
    "0x0000000000000000000000000000000000000000000000000000000000000001",
  );
});

test("getStorageSlot resolves struct fields and whole structs", () => {
  expect(getStorageSlot(layout, "metadata.lastUpdate")).toBe(
    "0x0000000000000000000000000000000000000000000000000000000000000004",
  );
  expect(getStorageSlot(layout, "metadata")).toMatchInlineSnapshot(`
    [
      "0x0000000000000000000000000000000000000000000000000000000000000004",
      "0x0000000000000000000000000000000000000000000000000000000000000005",
      "0x0000000000000000000000000000000000000000000000000000000000000006",
    ]
  `);
});

test("getStorageSlot resolves fixed arrays", () => {
  expect(getStorageSlot(layout, "fixedNumbers[0]")).toBe(
    "0x0000000000000000000000000000000000000000000000000000000000000008",
  );
  expect(getStorageSlot(layout, "fixedNumbers[1]")).toBe(
    "0x0000000000000000000000000000000000000000000000000000000000000008",
  );
  expect(getStorageSlot(layout, "fixedNumbers[2]")).toBe(
    "0x0000000000000000000000000000000000000000000000000000000000000009",
  );
  expect(getStorageSlot(layout, "fixedNumbers")).toMatchInlineSnapshot(`
    [
      "0x0000000000000000000000000000000000000000000000000000000000000008",
      "0x0000000000000000000000000000000000000000000000000000000000000009",
    ]
  `);
});

test("getStorageSlot resolves dynamic arrays", () => {
  expect(getStorageSlot(layout, "dynamicNumbers")).toBe(
    "0x000000000000000000000000000000000000000000000000000000000000000a",
  );
  expect(getStorageSlot(layout, "dynamicNumbers[0]")).toBe(
    "0xc65a7bb8d6351c1cf70c95a316cc6a92839c986682d98bc35f958f4883f9d2a8",
  );
  expect(getStorageSlot(layout, "dynamicNumbers[1]")).toBe(
    "0xc65a7bb8d6351c1cf70c95a316cc6a92839c986682d98bc35f958f4883f9d2a9",
  );
});

test("getStorageSlot resolves bytes and strings", () => {
  expect(getStorageSlot(layout, "rawBytes")).toBe(
    "0x000000000000000000000000000000000000000000000000000000000000000b",
  );
  expect(getStorageSlot(layout, "message")).toBe(
    "0x000000000000000000000000000000000000000000000000000000000000000c",
  );
});

test("getStorageSlot resolves keyed mappings", () => {
  expect(getStorageSlot(layout, `balances[${OWNER}]`)).toMatchInlineSnapshot(
    `"0x6d30c68d4703e3ad11b778e8635b89709aaecadb8bd3f2e0e0cff25a4ee1fbbc"`,
  );
  expect(
    getStorageSlot(layout, `allowances[${OWNER}][${SPENDER}]`),
  ).toMatchInlineSnapshot(
    `"0x66bb189fb8ad2dc06d80417b1df23596990027a61c5f41caf2342b38c5163744"`,
  );
  expect(() => getStorageSlot(layout as StorageLayout, "balances")).toThrow(
    "mapping storage paths require a key: balances",
  );
  expect(() =>
    getStorageSlot(layout as StorageLayout, `allowances[${OWNER}]`),
  ).toThrow(`mapping storage paths require a key: allowances[${OWNER}]`);
});

test("getStorageSlot resolves fixed arrays of structs", () => {
  expect(getStorageSlot(complexLayout, "orders[1].amount")).toBe(
    "0x0000000000000000000000000000000000000000000000000000000000000003",
  );
  expect(getStorageSlot(complexLayout, "orders[0]")).toMatchInlineSnapshot(`
    [
      "0x0000000000000000000000000000000000000000000000000000000000000000",
      "0x0000000000000000000000000000000000000000000000000000000000000001",
    ]
  `);
  expect(getStorageSlot(complexLayout, "orders")).toMatchInlineSnapshot(`
    [
      "0x0000000000000000000000000000000000000000000000000000000000000000",
      "0x0000000000000000000000000000000000000000000000000000000000000001",
      "0x0000000000000000000000000000000000000000000000000000000000000002",
      "0x0000000000000000000000000000000000000000000000000000000000000003",
    ]
  `);
});

test("getStorageSlot resolves structs with array fields", () => {
  expect(getStorageSlot(complexLayout, "book.priceLevels[1]")).toBe(
    "0x000000000000000000000000000000000000000000000000000000000000000a",
  );
  expect(getStorageSlot(complexLayout, "book")).toMatchInlineSnapshot(`
    [
      "0x000000000000000000000000000000000000000000000000000000000000000a",
      "0x000000000000000000000000000000000000000000000000000000000000000b",
    ]
  `);
});

test("getStorageSlot resolves arrays of arrays", () => {
  expect(getStorageSlot(complexLayout, "matrix[1][0]")).toBe(
    "0x0000000000000000000000000000000000000000000000000000000000000015",
  );
  expect(getStorageSlot(complexLayout, "matrix")).toMatchInlineSnapshot(`
    [
      "0x0000000000000000000000000000000000000000000000000000000000000014",
      "0x0000000000000000000000000000000000000000000000000000000000000015",
    ]
  `);
});

test("getStorageSlot rejects whole structs with dynamic fields", () => {
  const dynamicStructLayout = {
    storage: [
      {
        astId: 20,
        contract: "src/Test.sol:Test",
        label: "holder",
        offset: 0,
        slot: "0",
        type: "t_struct(HasDynamic)21_storage",
      },
    ],
    types: {
      ...layout.types,
      "t_struct(HasDynamic)21_storage": {
        encoding: "inplace",
        label: "struct Test.HasDynamic",
        members: [
          {
            astId: 21,
            contract: "src/Test.sol:Test",
            label: "value",
            offset: 0,
            slot: "0",
            type: "t_uint256",
          },
          {
            astId: 22,
            contract: "src/Test.sol:Test",
            label: "balances",
            offset: 0,
            slot: "1",
            type: "t_mapping(t_address,t_uint256)",
          },
        ],
        numberOfBytes: "64",
      },
    },
  } as const satisfies StorageLayout;

  expect(getStorageSlot(dynamicStructLayout, "holder.value")).toBe(
    "0x0000000000000000000000000000000000000000000000000000000000000000",
  );
  expect(() => getStorageSlot(dynamicStructLayout, "holder")).toThrow(
    "cannot infer storage path for mapping 'holder.balances' from raw slots: Solidity mapping keys are hashed into storage slots and cannot be reversed from a slot alone",
  );
});

test("getStorageSlot rejects unsupported paths", () => {
  expect(() => getStorageSlot(layout, "balances[0x1234]")).toThrow(
    "mapping key for 'balances' must be 20 bytes",
  );
  expect(() => getStorageSlot(layout as StorageLayout, "balances")).toThrow(
    "mapping storage paths require a key: balances",
  );
  expect(() =>
    getStorageSlot(layout as StorageLayout, "fixedNumbers[3]"),
  ).toThrow("fixed array index out of bounds: fixedNumbers[3]");
});

test("getStoragePath returns no matches for untouched slots", () => {
  expect(getStoragePath(reversibleLayout, "0x123")).toMatchInlineSnapshot(`[]`);
});

test("getStoragePath maps changed slots to storage paths", () => {
  expect(getStoragePath(layout, "0x1")).toMatchInlineSnapshot(`
      [
        "owner",
        "paused",
      ]
    `);
});

test("getStoragePath returns struct leaf paths", () => {
  expect(getStoragePath(reversibleLayout, "0x4")).toMatchInlineSnapshot(`
      [
        "metadata.lastUpdate",
        "metadata.active",
      ]
    `);
});

test("getStoragePath returns fixed array paths", () => {
  expect(getStoragePath(reversibleLayout, "0x8")).toMatchInlineSnapshot(`
    [
      "fixedNumbers[0]",
      "fixedNumbers[1]",
    ]
  `);
});

test("getStoragePath rejects mappings because keys cannot be reversed", () => {
  const balanceSlot = getStorageSlot(layout, `balances[${OWNER}]`);

  expect(() => getStoragePath(layout, balanceSlot)).toThrow(
    "cannot infer storage path for mapping 'balances' from raw slots: Solidity mapping keys are hashed into storage slots and cannot be reversed from a slot alone",
  );
});

test("getStoragePath maps raw slots through known paths", () => {
  const balanceSlot = getStorageSlot(layout, `balances[${OWNER}]`);

  expect(
    getStoragePath(layout, "0x1", ["owner", "paused", `balances[${OWNER}]`]),
  ).toMatchInlineSnapshot(`
    [
      "owner",
      "paused",
    ]
  `);

  expect(
    getStoragePath(layout, balanceSlot, [
      "owner",
      "paused",
      `balances[${OWNER}]`,
    ]),
  ).toEqual([`balances[${OWNER}]`]);

  expect(
    getStoragePath(layout, "0xff", ["owner", "paused", `balances[${OWNER}]`]),
  ).toEqual([]);
});

test("getStoragePath expands composite known paths", () => {
  expect(getStoragePath(layout, "0x4", ["metadata"])).toMatchInlineSnapshot(`
    [
      "metadata.lastUpdate",
      "metadata.active",
    ]
  `);
});

test("decodeStoragePath decodes value types from raw slots", () => {
  const storage = {
    "0x0": "0x2a",
    "0x1": PACKED_OWNER_PAUSED,
    "0x2": "0xffff",
    "0x3": SALT,
    "0x4": METADATA_PACKED,
  } as const;

  expect(decodeStoragePath(layout, "totalSupply", storage)).toBe(42n);
  expect(decodeStoragePath(layout, "owner", storage)).toBe(OWNER);
  expect(decodeStoragePath(layout, "paused", storage)).toBe(true);
  expect(decodeStoragePath(layout, "debt", storage)).toBe(-1);
  expect(decodeStoragePath(layout, "salt", storage)).toBe(SALT);
  expect(decodeStoragePath(layout, "metadata.lastUpdate", storage)).toBe(42n);
  expect(decodeStoragePath(layout, "metadata.active", storage)).toBe(true);
  expect(() => decodeUnknownStoragePath(layout, "metadata", storage)).toThrow(
    "storage path does not point to a leaf value: metadata",
  );
});

test("decodeStoragePath decodes fixed array elements", () => {
  const storage = {
    "0x8": PACKED_FIXED_NUMBERS,
  } as const;

  expect(decodeStoragePath(layout, "fixedNumbers[0]", storage)).toBe(1n);
  expect(decodeStoragePath(layout, "fixedNumbers[1]", storage)).toBe(2n);
  expect(() =>
    decodeUnknownStoragePath(layout, "fixedNumbers", storage),
  ).toThrow("storage path does not point to a leaf value: fixedNumbers");
});

test("decodeStoragePath decodes dynamic array elements", () => {
  const storage = {
    [expectSingleSlot(getStorageSlot(layout, "dynamicNumbers"))]: "0x2",
    [getStorageSlot(layout, "dynamicNumbers[0]")]: "0x1",
    [getStorageSlot(layout, "dynamicNumbers[1]")]: "0x2",
  } as const;

  expect(() =>
    decodeUnknownStoragePath(layout, "dynamicNumbers", storage),
  ).toThrow("storage path does not point to a leaf value: dynamicNumbers");
  expect(decodeStoragePath(layout, "dynamicNumbers[1]", storage)).toBe(2n);
});

test("decodeStoragePath decodes bytes and strings", () => {
  const shortStorage = writesToStorage({
    ...encodeStoragePath(layout, "rawBytes", "0x1234"),
    ...encodeStoragePath(layout, "message", "hello"),
  });
  const longBytes = `0x${"11".repeat(33)}` as const;
  const longString = "x".repeat(33);
  const longStorage = writesToStorage({
    ...encodeStoragePath(layout, "rawBytes", longBytes),
    ...encodeStoragePath(layout, "message", longString),
  });

  expect(decodeStoragePath(layout, "rawBytes", shortStorage)).toBe("0x1234");
  expect(decodeStoragePath(layout, "message", shortStorage)).toBe("hello");
  expect(decodeStoragePath(layout, "rawBytes", longStorage)).toBe(longBytes);
  expect(decodeStoragePath(layout, "message", longStorage)).toBe(longString);
});

test("decodeStoragePath decodes keyed mappings", () => {
  const storage = {
    [getStorageSlot(layout, `balances[${OWNER}]`)]: "0x2a",
    [getStorageSlot(layout, `allowances[${OWNER}][${SPENDER}]`)]: "0x64",
  } as const;

  expect(decodeStoragePath(layout, `balances[${OWNER}]`, storage)).toBe(42n);
  expect(
    decodeStoragePath(layout, `allowances[${OWNER}][${SPENDER}]`, storage),
  ).toBe(100n);
  expect(() =>
    decodeUnknownStoragePath(layout, `allowances[${OWNER}]`, storage),
  ).toThrow(`mapping storage paths require a key: allowances[${OWNER}]`);
});

test("encodeStoragePath encodes full-slot value types", () => {
  expect(encodeStoragePath(layout, "totalSupply", 42n)).toMatchInlineSnapshot(`
    {
      "0x0000000000000000000000000000000000000000000000000000000000000000": {
        "mask": "0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
        "value": "0x000000000000000000000000000000000000000000000000000000000000002a",
      },
    }
  `);
  expect(encodeStoragePath(layout, "salt", SALT)).toMatchInlineSnapshot(`
    {
      "0x0000000000000000000000000000000000000000000000000000000000000003": {
        "mask": "0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
        "value": "0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
      },
    }
  `);
});

test("encodeStoragePath returns masks for packed values", () => {
  const writes = encodeStoragePath(layout, "paused", false);
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

test("encodeStoragePath encodes nested struct fields", () => {
  expect(
    encodeStoragePath(layout, "metadata.active", false),
  ).toMatchInlineSnapshot(`
    {
      "0x0000000000000000000000000000000000000000000000000000000000000004": {
        "mask": "0x0000000000000000000000000000000000000000000000ff0000000000000000",
        "value": "0x0000000000000000000000000000000000000000000000000000000000000000",
      },
    }
  `);
  expect(() =>
    encodeUnknownStoragePath(layout, "metadata", {
      active: false,
      admin: OWNER,
      inner: { count: 100n },
      lastUpdate: 43n,
    }),
  ).toThrow("storage path does not point to a leaf value: metadata");
});

test("encodeStoragePath encodes fixed array elements", () => {
  expect(
    encodeStoragePath(layout, "fixedNumbers[1]", 3n),
  ).toMatchInlineSnapshot(`
    {
      "0x0000000000000000000000000000000000000000000000000000000000000008": {
        "mask": "0xffffffffffffffffffffffffffffffff00000000000000000000000000000000",
        "value": "0x0000000000000000000000000000000300000000000000000000000000000000",
      },
    }
  `);
});

test("encodeStoragePath encodes dynamic array elements", () => {
  expect(
    encodeStoragePath(layout, "dynamicNumbers[1]", 3n),
  ).toMatchInlineSnapshot(`
    {
      "0xc65a7bb8d6351c1cf70c95a316cc6a92839c986682d98bc35f958f4883f9d2a9": {
        "mask": "0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
        "value": "0x0000000000000000000000000000000000000000000000000000000000000003",
      },
    }
  `);
  expect(() =>
    encodeUnknownStoragePath(layout, "dynamicNumbers", [1n, 2n]),
  ).toThrow("storage path does not point to a leaf value: dynamicNumbers");
});

test("encodeStoragePath encodes bytes and strings", () => {
  expect(
    encodeStoragePath(layout, "rawBytes", "0x1234"),
  ).toMatchInlineSnapshot(`
    {
      "0x000000000000000000000000000000000000000000000000000000000000000b": {
        "mask": "0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
        "value": "0x1234000000000000000000000000000000000000000000000000000000000004",
      },
    }
  `);
  expect(encodeStoragePath(layout, "message", "hello")).toMatchInlineSnapshot(`
    {
      "0x000000000000000000000000000000000000000000000000000000000000000c": {
        "mask": "0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
        "value": "0x68656c6c6f00000000000000000000000000000000000000000000000000000a",
      },
    }
  `);
  expect(
    encodeStoragePath(layout, "rawBytes", `0x${"11".repeat(33)}`),
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
});

test("encodeStoragePath encodes keyed mappings", () => {
  expect(
    encodeStoragePath(layout, `balances[${OWNER}]`, 42n),
  ).toMatchInlineSnapshot(`
    {
      "0x6d30c68d4703e3ad11b778e8635b89709aaecadb8bd3f2e0e0cff25a4ee1fbbc": {
        "mask": "0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
        "value": "0x000000000000000000000000000000000000000000000000000000000000002a",
      },
    }
  `);
});

test("encodeStorage encodes decoded contract-shaped state", () => {
  const state = {
    totalSupply: 42n,
    owner: OWNER,
    paused: true,
    debt: -1,
    salt: SALT,
    metadata: {
      lastUpdate: 42n,
      active: true,
      admin: OWNER,
      inner: { count: 100n },
    },
    balances: { [OWNER]: 43n },
    fixedNumbers: [1n, 2n, 3n],
    dynamicNumbers: [4n, 5n],
    rawBytes: "0x1234",
    message: "hello",
    allowances: { [OWNER]: { [SPENDER]: 44n } },
  } satisfies StorageLayoutToPrimitiveType<typeof layout>;

  const storage = encodeStorage(layout, state);

  expect(decodeStoragePath(layout, "totalSupply", storage)).toBe(42n);
  expect(decodeStoragePath(layout, "owner", storage)).toBe(OWNER);
  expect(decodeStoragePath(layout, "paused", storage)).toBe(true);
  expect(decodeStoragePath(layout, "debt", storage)).toBe(-1);
  expect(decodeStoragePath(layout, "salt", storage)).toBe(SALT);
  expect(decodeStoragePath(layout, "metadata.lastUpdate", storage)).toBe(42n);
  expect(decodeStoragePath(layout, "metadata.active", storage)).toBe(true);
  expect(decodeStoragePath(layout, "metadata.admin", storage)).toBe(OWNER);
  expect(decodeStoragePath(layout, "metadata.inner.count", storage)).toBe(100n);
  expect(decodeStoragePath(layout, `balances[${OWNER}]`, storage)).toBe(43n);
  expect(decodeStoragePath(layout, "fixedNumbers[0]", storage)).toBe(1n);
  expect(decodeStoragePath(layout, "fixedNumbers[1]", storage)).toBe(2n);
  expect(decodeStoragePath(layout, "fixedNumbers[2]", storage)).toBe(3n);
  expect(decodeStoragePath(layout, "dynamicNumbers[0]", storage)).toBe(4n);
  expect(decodeStoragePath(layout, "dynamicNumbers[1]", storage)).toBe(5n);
  expect(decodeStoragePath(layout, "rawBytes", storage)).toBe("0x1234");
  expect(decodeStoragePath(layout, "message", storage)).toBe("hello");
  expect(
    decodeStoragePath(layout, `allowances[${OWNER}][${SPENDER}]`, storage),
  ).toBe(44n);
});

test("encodeStorage validates decoded state shape", () => {
  expect(() =>
    encodeStorage(layout, {
      totalSupply: 42n,
    } as unknown as StorageLayoutToPrimitiveType<typeof layout>),
  ).toThrow("missing decoded state value for path: owner");

  expect(() =>
    encodeStorage(layout, {
      totalSupply: 42n,
      owner: OWNER,
      paused: true,
      debt: -1,
      salt: SALT,
      metadata: {
        lastUpdate: 42n,
        active: true,
        admin: OWNER,
        inner: { count: 100n },
      },
      balances: {},
      fixedNumbers: [1n, 2n],
      dynamicNumbers: [],
      rawBytes: "0x",
      message: "",
      allowances: {},
    } as unknown as StorageLayoutToPrimitiveType<typeof layout>),
  ).toThrow("fixed array length mismatch at fixedNumbers: expected 3, got 2");
});

test("unsupported data types fail loudly", () => {
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
      {
        astId: 2,
        contract: "src/Test.sol:Test",
        label: "callback",
        offset: 0,
        slot: "1",
        type: "t_function_internal",
      },
      {
        astId: 3,
        contract: "src/Test.sol:Test",
        label: "externalCallback",
        offset: 0,
        slot: "2",
        type: "t_function_external",
      },
      {
        astId: 4,
        contract: "src/Test.sol:Test",
        label: "token",
        offset: 0,
        slot: "3",
        type: "t_contract(IERC20)1",
      },
      {
        astId: 5,
        contract: "src/Test.sol:Test",
        label: "price",
        offset: 0,
        slot: "4",
        type: "t_userDefinedValueType(Price)5",
      },
    ],
    types: {
      t_fixed128x18: {
        encoding: "inplace",
        label: "fixed128x18",
        numberOfBytes: "16",
      },
      t_function_internal: {
        encoding: "inplace",
        label: "function () internal",
        numberOfBytes: "8",
      },
      t_function_external: {
        encoding: "inplace",
        label: "function () external",
        numberOfBytes: "24",
      },
      "t_contract(IERC20)1": {
        encoding: "inplace",
        label: "contract IERC20",
        numberOfBytes: "20",
      },
      "t_userDefinedValueType(Price)5": {
        encoding: "inplace",
        label: "Price",
        numberOfBytes: "32",
      },
    },
  } as const satisfies StorageLayout;

  expect(() => getStorageSlot(unsupportedLayout, "rate")).toThrow(
    "unsupported storage path type 'fixed128x18' for rate",
  );
  expect(() => getStorageSlot(unsupportedLayout, "callback")).toThrow(
    "unsupported storage path type 'function () internal' for callback",
  );
  expect(() => getStorageSlot(unsupportedLayout, "externalCallback")).toThrow(
    "unsupported storage path type 'function () external' for externalCallback",
  );
  expect(() => getStorageSlot(unsupportedLayout, "token")).toThrow(
    "unsupported storage path type 'contract IERC20' for token",
  );
  expect(() => getStorageSlot(unsupportedLayout, "price")).toThrow(
    "unsupported storage path type 'Price' for price",
  );
});
