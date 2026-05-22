import { expect, test } from "bun:test";
import { complexLayout, layout, OWNER, SPENDER } from "../test/utils";
import { getStorageSlot, type StorageLayout } from "./index";

test("getStorageSlot resolves top-level value types", () => {
  expect(getStorageSlot(layout, "totalSupply")).toEqual([
    "0x0000000000000000000000000000000000000000000000000000000000000000",
  ]);
  expect(getStorageSlot(layout, "owner")).toEqual([
    "0x0000000000000000000000000000000000000000000000000000000000000001",
  ]);
  expect(getStorageSlot(layout, "paused")).toEqual([
    "0x0000000000000000000000000000000000000000000000000000000000000001",
  ]);
  expect(getStorageSlot(layout, "debt")).toEqual([
    "0x0000000000000000000000000000000000000000000000000000000000000002",
  ]);
  expect(getStorageSlot(layout, "salt")).toEqual([
    "0x0000000000000000000000000000000000000000000000000000000000000003",
  ]);
});

test("getStorageSlot resolves struct fields and whole structs", () => {
  expect(getStorageSlot(layout, "metadata.lastUpdate")).toEqual([
    "0x0000000000000000000000000000000000000000000000000000000000000004",
  ]);
  expect(getStorageSlot(layout, "metadata.active")).toEqual([
    "0x0000000000000000000000000000000000000000000000000000000000000004",
  ]);
  expect(getStorageSlot(layout, "metadata.admin")).toEqual([
    "0x0000000000000000000000000000000000000000000000000000000000000005",
  ]);
  expect(getStorageSlot(layout, "metadata.inner.count")).toEqual([
    "0x0000000000000000000000000000000000000000000000000000000000000006",
  ]);
  expect(getStorageSlot(layout, "metadata")).toMatchInlineSnapshot(`
    [
      "0x0000000000000000000000000000000000000000000000000000000000000004",
      "0x0000000000000000000000000000000000000000000000000000000000000005",
      "0x0000000000000000000000000000000000000000000000000000000000000006",
    ]
  `);
});

test("getStorageSlot resolves fixed arrays", () => {
  expect(getStorageSlot(layout, "fixedNumbers[0]")).toEqual([
    "0x0000000000000000000000000000000000000000000000000000000000000008",
  ]);
  expect(getStorageSlot(layout, "fixedNumbers[1]")).toEqual([
    "0x0000000000000000000000000000000000000000000000000000000000000008",
  ]);
  expect(getStorageSlot(layout, "fixedNumbers[2]")).toEqual([
    "0x0000000000000000000000000000000000000000000000000000000000000009",
  ]);
  expect(getStorageSlot(layout, "fixedNumbers")).toMatchInlineSnapshot(`
    [
      "0x0000000000000000000000000000000000000000000000000000000000000008",
      "0x0000000000000000000000000000000000000000000000000000000000000009",
    ]
  `);
});

test("getStorageSlot resolves dynamic array roots to length slots and indexed elements to data slots", () => {
  expect(getStorageSlot(layout, "dynamicNumbers")).toEqual([
    "0x000000000000000000000000000000000000000000000000000000000000000a",
  ]);
  expect(getStorageSlot(layout, "dynamicNumbers[0]")).toEqual([
    "0xc65a7bb8d6351c1cf70c95a316cc6a92839c986682d98bc35f958f4883f9d2a8",
  ]);
  expect(getStorageSlot(layout, "dynamicNumbers[1]")).toEqual([
    "0xc65a7bb8d6351c1cf70c95a316cc6a92839c986682d98bc35f958f4883f9d2a9",
  ]);
});

test("getStorageSlot resolves bytes and strings", () => {
  expect(getStorageSlot(layout, "rawBytes")).toEqual([
    "0x000000000000000000000000000000000000000000000000000000000000000b",
  ]);
  expect(getStorageSlot(layout, "message")).toEqual([
    "0x000000000000000000000000000000000000000000000000000000000000000c",
  ]);
});

test("getStorageSlot resolves keyed mappings", () => {
  expect(getStorageSlot(layout, `balances[${OWNER}]`)).toMatchInlineSnapshot(`
    [
      "0x6d30c68d4703e3ad11b778e8635b89709aaecadb8bd3f2e0e0cff25a4ee1fbbc",
    ]
  `);
  expect(
    getStorageSlot(layout, `allowances[${OWNER}][${SPENDER}]`),
  ).toMatchInlineSnapshot(`
    [
      "0x66bb189fb8ad2dc06d80417b1df23596990027a61c5f41caf2342b38c5163744",
    ]
  `);
});

test("getStorageSlot resolves fixed arrays of structs", () => {
  expect(getStorageSlot(complexLayout, "orders[1].amount")).toEqual([
    "0x0000000000000000000000000000000000000000000000000000000000000003",
  ]);
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
  expect(getStorageSlot(complexLayout, "book.priceLevels[1]")).toEqual([
    "0x000000000000000000000000000000000000000000000000000000000000000a",
  ]);
  expect(getStorageSlot(complexLayout, "book")).toMatchInlineSnapshot(`
    [
      "0x000000000000000000000000000000000000000000000000000000000000000a",
      "0x000000000000000000000000000000000000000000000000000000000000000b",
    ]
  `);
});

test("getStorageSlot resolves arrays of arrays", () => {
  expect(getStorageSlot(complexLayout, "matrix[1][0]")).toEqual([
    "0x0000000000000000000000000000000000000000000000000000000000000015",
  ]);
  expect(getStorageSlot(complexLayout, "matrix")).toMatchInlineSnapshot(`
    [
      "0x0000000000000000000000000000000000000000000000000000000000000014",
      "0x0000000000000000000000000000000000000000000000000000000000000015",
    ]
  `);
});

test("getStorageSlot rejects incomplete or invalid storage variables", () => {
  expect(() => getStorageSlot(layout, "balances[0x1234]")).toThrow(
    "mapping key for 'balances' must be 20 bytes",
  );
  expect(() => getStorageSlot(layout as StorageLayout, "balances")).toThrow(
    "mapping storage paths require a key: balances",
  );
  expect(() =>
    getStorageSlot(layout as StorageLayout, `allowances[${OWNER}]`),
  ).toThrow(`mapping storage paths require a key: allowances[${OWNER}]`);
  expect(() =>
    getStorageSlot(layout as StorageLayout, "fixedNumbers[3]"),
  ).toThrow("fixed array index out of bounds: fixedNumbers[3]");
  expect(() => getStorageSlot(layout as StorageLayout, "missing")).toThrow(
    "storage variable not found: missing",
  );
});

test("getStorageSlot rejects whole structs with dynamic mapping fields", () => {
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

  expect(getStorageSlot(dynamicStructLayout, "holder.value")).toEqual([
    "0x0000000000000000000000000000000000000000000000000000000000000000",
  ]);
  expect(() => getStorageSlot(dynamicStructLayout, "holder")).toThrow(
    "cannot infer storage path for mapping 'holder.balances' from raw slots: Solidity mapping keys are hashed into storage slots and cannot be reversed from a slot alone",
  );
});

test("getStorageSlot rejects unsupported variable types", () => {
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
