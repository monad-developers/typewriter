import { expect, test } from "bun:test";
import { Hash, Hex } from "ox";
import { layout, OWNER, slotOf } from "../test/utils";
import { getDynamicArrayLength, type StorageLayout } from "./index";

test("getDynamicArrayLength reads the length from the array slot", () => {
  const lengthSlot = slotOf(layout, "dynamicNumbers");

  expect(
    getDynamicArrayLength(layout, "dynamicNumbers", { [lengthSlot]: "0x3" }),
  ).toBe(3);
  expect(
    getDynamicArrayLength(layout, "dynamicNumbers", { "0xa": "0x0" }),
  ).toBe(0);
});

test("getDynamicArrayLength reads an array under a mapping from its hashed slot", () => {
  const historyLayout = {
    storage: [
      {
        astId: 1,
        contract: "src/Test.sol:Test",
        label: "history",
        offset: 0,
        slot: "2",
        type: "t_mapping(t_address,t_array(t_uint256)dyn_storage)",
      },
    ],
    types: {
      t_address: { encoding: "inplace", label: "address", numberOfBytes: "20" },
      t_uint256: { encoding: "inplace", label: "uint256", numberOfBytes: "32" },
      "t_array(t_uint256)dyn_storage": {
        base: "t_uint256",
        encoding: "dynamic_array",
        label: "uint256[]",
        numberOfBytes: "32",
      },
      "t_mapping(t_address,t_array(t_uint256)dyn_storage)": {
        encoding: "mapping",
        key: "t_address",
        label: "mapping(address => uint256[])",
        numberOfBytes: "32",
        value: "t_array(t_uint256)dyn_storage",
      },
    },
  } as const satisfies StorageLayout;
  const lengthSlot = Hash.keccak256(
    Hex.concat(Hex.padLeft(OWNER, 32), Hex.fromNumber(2, { size: 32 })),
  );

  expect(
    getDynamicArrayLength(historyLayout, `history[${OWNER}]`, {
      [lengthSlot]: "0x5",
    }),
  ).toBe(5);
});

test("getDynamicArrayLength fails loudly", () => {
  const getLength = getDynamicArrayLength as (
    layout: StorageLayout,
    array: string,
    storage: { [slot: `0x${string}`]: `0x${string}` },
  ) => number;

  expect(() => getLength(layout, "dynamicNumbers", {})).toThrow(
    `storage value not found for slot: ${slotOf(layout, "dynamicNumbers")}`,
  );
  expect(() =>
    getLength(layout, "dynamicNumbers", { "0xa": `0x${"ff".repeat(32)}` }),
  ).toThrow("is larger than Number.MAX_SAFE_INTEGER: dynamicNumbers");
  expect(() => getLength(layout, "fixedNumbers", {})).toThrow(
    "storage path is not a dynamic array: fixedNumbers",
  );
  expect(() => getLength(layout, "metadata", {})).toThrow(
    "storage path is not a dynamic array: metadata",
  );
});
