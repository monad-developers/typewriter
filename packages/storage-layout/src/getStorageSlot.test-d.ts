import { expectTypeOf, test } from "bun:test";
import type { Hex } from "ox";
import type { StorageLayout } from "./index";
import { getStorageSlot } from "./index";

const layout = {
  storage: [
    {
      astId: 1,
      contract: "src/Test.sol:Test",
      label: "supply",
      offset: 0,
      slot: "0",
      type: "t_uint256",
    },
    {
      astId: 2,
      contract: "src/Test.sol:Test",
      label: "metadata",
      offset: 0,
      slot: "1",
      type: "t_struct(Metadata)10_storage",
    },
    {
      astId: 3,
      contract: "src/Test.sol:Test",
      label: "numbers",
      offset: 0,
      slot: "2",
      type: "t_array(t_uint256)dyn_storage",
    },
    {
      astId: 4,
      contract: "src/Test.sol:Test",
      label: "balances",
      offset: 0,
      slot: "3",
      type: "t_mapping(t_address,t_uint256)",
    },
    {
      astId: 5,
      contract: "src/Test.sol:Test",
      label: "fixedNumbers",
      offset: 0,
      slot: "4",
      type: "t_array(t_uint128)3_storage",
    },
  ],
  types: {
    t_address: {
      encoding: "inplace",
      label: "address",
      numberOfBytes: "20",
    },
    "t_array(t_uint256)dyn_storage": {
      base: "t_uint256",
      encoding: "dynamic_array",
      label: "uint256[]",
      numberOfBytes: "32",
    },
    "t_mapping(t_address,t_uint256)": {
      encoding: "mapping",
      key: "t_address",
      label: "mapping(address => uint256)",
      numberOfBytes: "32",
      value: "t_uint256",
    },
    "t_struct(Metadata)10_storage": {
      encoding: "inplace",
      label: "struct Test.Metadata",
      members: [
        {
          astId: 6,
          contract: "src/Test.sol:Test",
          label: "lastUpdate",
          offset: 0,
          slot: "0",
          type: "t_uint64",
        },
        {
          astId: 7,
          contract: "src/Test.sol:Test",
          label: "paused",
          offset: 8,
          slot: "0",
          type: "t_bool",
        },
      ],
      numberOfBytes: "32",
    },
    t_bool: {
      encoding: "inplace",
      label: "bool",
      numberOfBytes: "1",
    },
    t_uint64: {
      encoding: "inplace",
      label: "uint64",
      numberOfBytes: "8",
    },
    t_uint128: {
      encoding: "inplace",
      label: "uint128",
      numberOfBytes: "16",
    },
    t_uint256: {
      encoding: "inplace",
      label: "uint256",
      numberOfBytes: "32",
    },
    "t_array(t_uint128)3_storage": {
      base: "t_uint128",
      encoding: "inplace",
      label: "uint128[3]",
      numberOfBytes: "64",
    },
  },
} as const satisfies StorageLayout;

const multiSlotLayout = {
  storage: [
    {
      astId: 1,
      contract: "src/Test.sol:Test",
      label: "metadata",
      offset: 0,
      slot: "0",
      type: "t_struct(Metadata)10_storage",
    },
  ],
  types: {
    "t_struct(Metadata)10_storage": {
      encoding: "inplace",
      label: "struct Test.Metadata",
      members: [
        {
          astId: 2,
          contract: "src/Test.sol:Test",
          label: "first",
          offset: 0,
          slot: "0",
          type: "t_uint256",
        },
        {
          astId: 3,
          contract: "src/Test.sol:Test",
          label: "second",
          offset: 0,
          slot: "1",
          type: "t_uint256",
        },
      ],
      numberOfBytes: "64",
    },
    t_uint256: {
      encoding: "inplace",
      label: "uint256",
      numberOfBytes: "32",
    },
  },
} as const satisfies StorageLayout;

const dynamicArrayOfMultiSlotElementsLayout = {
  storage: [
    {
      astId: 1,
      contract: "src/Test.sol:Test",
      label: "orders",
      offset: 0,
      slot: "0",
      type: "t_array(t_struct(Order)10_storage)dyn_storage",
    },
  ],
  types: {
    "t_array(t_struct(Order)10_storage)dyn_storage": {
      base: "t_struct(Order)10_storage",
      encoding: "dynamic_array",
      label: "struct Test.Order[]",
      numberOfBytes: "32",
    },
    "t_struct(Order)10_storage": {
      encoding: "inplace",
      label: "struct Test.Order",
      members: [
        {
          astId: 2,
          contract: "src/Test.sol:Test",
          label: "amount",
          offset: 0,
          slot: "0",
          type: "t_uint256",
        },
        {
          astId: 3,
          contract: "src/Test.sol:Test",
          label: "price",
          offset: 0,
          slot: "1",
          type: "t_uint256",
        },
      ],
      numberOfBytes: "64",
    },
    t_uint256: {
      encoding: "inplace",
      label: "uint256",
      numberOfBytes: "32",
    },
  },
} as const satisfies StorageLayout;

test("getStorageSlot has the direct generic selector constraint", () => {
  const slot = getStorageSlot<typeof layout, "supply">(layout, "supply");
  const typeAssertions = () => {
    // @ts-expect-error explicit selector generic is constrained to valid paths
    getStorageSlot<typeof layout, "missing">(layout, "missing");
  };

  expectTypeOf(slot).toEqualTypeOf<Hex.Hex[]>();
  expectTypeOf(typeAssertions).toEqualTypeOf<() => void>();
});

test("getStorageSlot infers single-slot and multi-slot return types", () => {
  const supplySlot = getStorageSlot(layout, "supply");
  const metadataSlot = getStorageSlot(layout, "metadata");
  const dynamicArrayRootSlot = getStorageSlot(layout, "numbers");
  const dynamicArrayElementSlot = getStorageSlot(layout, "numbers[0]");
  const dynamicArrayMultiSlotElementSlot = getStorageSlot(
    dynamicArrayOfMultiSlotElementsLayout,
    "orders[0]",
  );
  const mappingValueSlot = getStorageSlot(
    layout,
    `balances[${"0x123" as Hex.Hex}]`,
  );
  const fixedArraySlot = getStorageSlot(layout, "fixedNumbers");
  const multiSlotMetadata = getStorageSlot(multiSlotLayout, "metadata");

  expectTypeOf(supplySlot).toEqualTypeOf<Hex.Hex[]>();
  expectTypeOf(metadataSlot).toEqualTypeOf<Hex.Hex[]>();
  expectTypeOf(dynamicArrayRootSlot).toEqualTypeOf<Hex.Hex[]>();
  expectTypeOf(dynamicArrayElementSlot).toEqualTypeOf<Hex.Hex[]>();
  expectTypeOf(dynamicArrayMultiSlotElementSlot).toEqualTypeOf<Hex.Hex[]>();
  expectTypeOf(mappingValueSlot).toEqualTypeOf<Hex.Hex[]>();
  expectTypeOf(fixedArraySlot).toEqualTypeOf<Hex.Hex[]>();
  expectTypeOf(multiSlotMetadata).toEqualTypeOf<Hex.Hex[]>();
});

test("getStorageSlot rejects invalid variables at type-check time", () => {
  const typeAssertions = () => {
    getStorageSlot(layout, "metadata");
    getStorageSlot(layout, "numbers");
    getStorageSlot(layout, "numbers[0]");

    // @ts-expect-error unknown roots are not storage variables
    getStorageSlot(layout, "missing");
    // @ts-expect-error mappings require keys
    getStorageSlot(layout, "balances");
    // @ts-expect-error fixed array index is out of bounds
    getStorageSlot(layout, "fixedNumbers[3]");
  };
  expectTypeOf(typeAssertions).toEqualTypeOf<() => void>();
});

test("getStorageSlot gracefully falls back for loose layouts", () => {
  const typeAssertions = () => {
    const looseLayout = {} as StorageLayout;
    const looseSlot = getStorageSlot(looseLayout, "anything");

    expectTypeOf(looseSlot).toEqualTypeOf<Hex.Hex[]>();
  };
  expectTypeOf(typeAssertions).toEqualTypeOf<() => void>();
});
