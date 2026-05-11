import { expect, test } from "bun:test";
import {
  complexLayout,
  layout,
  METADATA_PACKED,
  OWNER,
  PACKED_OWNER_PAUSED,
  SALT,
} from "../test/utils";
import {
  decodeStorage,
  encodeStorage,
  formatStoragePath,
  getStoragePath,
  getStorageSlot,
  type StorageLayout,
} from "./index";

const reversibleLayout = {
  ...layout,
  storage: layout.storage.filter((item) => item.label !== "balances"),
} satisfies StorageLayout;

const PACKED_FIXED_NUMBERS =
  "0x0000000000000000000000000000000200000000000000000000000000000001";

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
    "subscript storage paths are not supported yet: balances[0x1234]",
  );
  expect(() => getStorageSlot(layout, "balances")).toThrow(
    "unsupported storage path type 'mapping(address => uint256)' for balances",
  );
  expect(() => getStorageSlot(layout, "fixedNumbers[3]")).toThrow(
    "fixed array index out of bounds: fixedNumbers[3]",
  );
});

test("getStoragePath returns no matches for untouched slots", () => {
  expect(
    getStoragePath(reversibleLayout, ["0x123"]).map(formatStoragePath),
  ).toMatchInlineSnapshot(`[]`);
});

test("getStoragePath maps changed slots to storage paths", () => {
  expect(
    getStoragePath(reversibleLayout, "0x1").map(formatStoragePath),
  ).toMatchInlineSnapshot(`
      [
        "owner",
        "paused",
      ]
    `);
});

test("getStoragePath returns struct leaf paths", () => {
  expect(
    getStoragePath(reversibleLayout, ["0x4"]).map(formatStoragePath),
  ).toMatchInlineSnapshot(`
      [
        "metadata.lastUpdate",
        "metadata.active",
      ]
    `);
});

test("getStoragePath returns fixed array paths", () => {
  expect(
    getStoragePath(reversibleLayout, "0x8").map(formatStoragePath),
  ).toMatchInlineSnapshot(`
    [
      "fixedNumbers[0]",
      "fixedNumbers[1]",
    ]
  `);
});

test("getStoragePath rejects mappings because keys cannot be reversed", () => {
  expect(() => getStoragePath(layout, ["0x1"])).toThrow(
    "cannot infer storage path for mapping 'balances' from raw slots: Solidity mapping keys are hashed into storage slots and cannot be reversed from a slot alone",
  );
});

test("decodeStorage decodes value types from raw slots", () => {
  const storage = {
    "0x0": "0x2a",
    "0x1": PACKED_OWNER_PAUSED,
    "0x2": "0xffff",
    "0x3": SALT,
    "0x4": METADATA_PACKED,
  } as const;

  expect(decodeStorage(layout, "totalSupply", storage)).toBe(42n);
  expect(decodeStorage(layout, "owner", storage)).toBe(OWNER);
  expect(decodeStorage(layout, "paused", storage)).toBe(true);
  expect(decodeStorage(layout, "debt", storage)).toBe(-1);
  expect(decodeStorage(layout, "salt", storage)).toBe(SALT);
  expect(decodeStorage(layout, "metadata.lastUpdate", storage)).toBe(42n);
  expect(decodeStorage(layout, "metadata.active", storage)).toBe(true);
  expect(() => decodeStorage(layout, "metadata", storage)).toThrow(
    "storage path does not point to a leaf value: metadata",
  );
});

test("decodeStorage decodes fixed array elements", () => {
  const storage = {
    "0x8": PACKED_FIXED_NUMBERS,
  } as const;

  expect(decodeStorage(layout, "fixedNumbers[0]", storage)).toBe(1n);
  expect(decodeStorage(layout, "fixedNumbers[1]", storage)).toBe(2n);
  expect(() => decodeStorage(layout, "fixedNumbers", storage)).toThrow(
    "storage path does not point to a leaf value: fixedNumbers",
  );
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
  expect(encodeStorage(layout, "salt", SALT)).toMatchInlineSnapshot(`
    [
      {
        "slot": "0x0000000000000000000000000000000000000000000000000000000000000003",
        "value": "0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
      },
    ]
  `);
});

test("encodeStorage preserves neighboring bytes for packed values", () => {
  const storage = {
    "0x1": PACKED_OWNER_PAUSED,
  } as const;

  expect(
    encodeStorage(layout, "paused", false, storage),
  ).toMatchInlineSnapshot(`
    [
      {
        "slot": "0x0000000000000000000000000000000000000000000000000000000000000001",
        "value": "0x0000000000000000000000001111111111111111111111111111111111111234",
      },
    ]
  `);
});

test("encodeStorage encodes nested struct fields", () => {
  const storage = {
    "0x4": METADATA_PACKED,
  } as const;

  expect(
    encodeStorage(layout, "metadata.active", false, storage),
  ).toMatchInlineSnapshot(`
    [
      {
        "slot": "0x0000000000000000000000000000000000000000000000000000000000000004",
        "value": "0x000000000000000000000000000000000000000000000000000000000000002a",
      },
    ]
  `);
  expect(() =>
    encodeStorage(
      layout,
      "metadata",
      {
        active: false,
        admin: OWNER,
        inner: { count: 100n },
        lastUpdate: 43n,
      },
      storage,
    ),
  ).toThrow("storage path does not point to a leaf value: metadata");
});

test("encodeStorage encodes fixed array elements", () => {
  const storage = {
    "0x8": PACKED_FIXED_NUMBERS,
  } as const;

  expect(
    encodeStorage(layout, "fixedNumbers[1]", 3n, storage),
  ).toMatchInlineSnapshot(`
    [
      {
        "slot": "0x0000000000000000000000000000000000000000000000000000000000000008",
        "value": "0x0000000000000000000000000000000300000000000000000000000000000001",
      },
    ]
  `);
});

test("encodeStorage requires existing slots for packed values", () => {
  expect(() => encodeStorage(layout, "paused", false)).toThrow(
    "existing storage value is required to encode packed path: paused",
  );
});
