import { expect, test } from "bun:test";
import { layout } from "../test/utils";
import { getStorageSlot, isStoragePathEnd, type StorageLayout } from "./index";

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

test("isStoragePathEnd identifies terminal paths", () => {
  expect(isStoragePathEnd(layout, "totalSupply")).toBe(true);
  expect(isStoragePathEnd(layout, "metadata")).toBe(false);
  expect(isStoragePathEnd(layout, "metadata.lastUpdate")).toBe(true);
  expect(isStoragePathEnd(layout, "metadata.inner")).toBe(false);
  expect(() => isStoragePathEnd(layout, "balances")).toThrow(
    "unsupported storage path type 'mapping(address => uint256)' for balances",
  );
});

test("nested and dynamic paths fail explicitly until implemented", () => {
  expect(() => getStorageSlot(layout, "balances[0x1234]")).toThrow(
    "subscript storage paths are not supported yet: balances[0x1234]",
  );
  expect(() => getStorageSlot(layout, "balances")).toThrow(
    "unsupported storage path type 'mapping(address => uint256)' for balances",
  );
});
