import { expectTypeOf, test } from "bun:test";
import type { StorageLayout, StorageVariable } from "./index";
import { getStorageVariable } from "./index";

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
      label: "balances",
      offset: 0,
      slot: "2",
      type: "t_mapping(t_address,t_uint256)",
    },
    {
      astId: 4,
      contract: "src/Test.sol:Test",
      label: "fixedNumbers",
      offset: 0,
      slot: "3",
      type: "t_array(t_uint128)3_storage",
    },
  ],
  types: {
    t_address: {
      encoding: "inplace",
      label: "address",
      numberOfBytes: "20",
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
          astId: 5,
          contract: "src/Test.sol:Test",
          label: "lastUpdate",
          offset: 0,
          slot: "0",
          type: "t_uint64",
        },
        {
          astId: 6,
          contract: "src/Test.sol:Test",
          label: "active",
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

test("getStorageVariable infers strict storage variable arrays", () => {
  const variables = getStorageVariable(layout, "0x0");

  expectTypeOf(variables).toEqualTypeOf<StorageVariable<typeof layout>[]>();
});

test("getStorageVariable accepts valid known storage variables", () => {
  const variables = getStorageVariable(layout, "0x0", [
    "supply",
    "metadata",
    "metadata.lastUpdate",
    `balances[${"0x123" as `0x${string}`}]`,
    "fixedNumbers[2]",
  ]);

  expectTypeOf(variables).toEqualTypeOf<StorageVariable<typeof layout>[]>();
});

test("getStorageVariable rejects invalid known variables", () => {
  const typeAssertions = () => {
    // @ts-expect-error unknown variables are not valid knownVariables
    getStorageVariable(layout, "0x0", ["missing"]);
    // @ts-expect-error mappings require keys in knownVariables
    getStorageVariable(layout, "0x0", ["balances"]);
    // @ts-expect-error fixed array index is out of bounds
    getStorageVariable(layout, "0x0", ["fixedNumbers[3]"]);
  };

  expectTypeOf(typeAssertions).toEqualTypeOf<() => void>();
});

test("getStorageVariable gracefully falls back for loose layouts", () => {
  const typeAssertions = () => {
    const looseLayout = {} as StorageLayout;
    const variables = getStorageVariable(looseLayout, "0x0", ["anything"]);

    expectTypeOf(variables).toEqualTypeOf<string[]>();
  };

  expectTypeOf(typeAssertions).toEqualTypeOf<() => void>();
});
