import { expectTypeOf, test } from "bun:test";
import type { Hex } from "ox";
import type { StorageLayout, StorageVariableDiff } from "./index";
import { decodeStorageDiff } from "./index";

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
      label: "flags",
      offset: 0,
      slot: "1",
      type: "t_uint24",
    },
    {
      astId: 3,
      contract: "src/Test.sol:Test",
      label: "owner",
      offset: 3,
      slot: "1",
      type: "t_address",
    },
    {
      astId: 4,
      contract: "src/Test.sol:Test",
      label: "metadata",
      offset: 0,
      slot: "2",
      type: "t_struct(Metadata)10_storage",
    },
    {
      astId: 5,
      contract: "src/Test.sol:Test",
      label: "numbers",
      offset: 0,
      slot: "4",
      type: "t_array(t_uint256)dyn_storage",
    },
    {
      astId: 6,
      contract: "src/Test.sol:Test",
      label: "balances",
      offset: 0,
      slot: "5",
      type: "t_mapping(t_address,t_uint256)",
    },
    {
      astId: 7,
      contract: "src/Test.sol:Test",
      label: "allowances",
      offset: 0,
      slot: "6",
      type: "t_mapping(t_address,t_mapping(t_address,t_uint256))",
    },
    {
      astId: 9,
      contract: "src/Test.sol:Test",
      label: "fixedNumbers",
      offset: 0,
      slot: "7",
      type: "t_array(t_uint128)3_storage",
    },
    {
      astId: 10,
      contract: "src/Test.sol:Test",
      label: "rawBytes",
      offset: 0,
      slot: "9",
      type: "t_bytes_storage",
    },
    {
      astId: 11,
      contract: "src/Test.sol:Test",
      label: "message",
      offset: 0,
      slot: "10",
      type: "t_string_storage",
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
    "t_mapping(t_address,t_mapping(t_address,t_uint256))": {
      encoding: "mapping",
      key: "t_address",
      label: "mapping(address => mapping(address => uint256))",
      numberOfBytes: "32",
      value: "t_mapping(t_address,t_uint256)",
    },
    "t_struct(Metadata)10_storage": {
      encoding: "inplace",
      label: "struct Test.Metadata",
      members: [
        {
          astId: 7,
          contract: "src/Test.sol:Test",
          label: "lastUpdate",
          offset: 0,
          slot: "0",
          type: "t_uint64",
        },
        {
          astId: 8,
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
    t_uint24: {
      encoding: "inplace",
      label: "uint24",
      numberOfBytes: "3",
    },
    t_uint64: {
      encoding: "inplace",
      label: "uint64",
      numberOfBytes: "8",
    },
    t_uint256: {
      encoding: "inplace",
      label: "uint256",
      numberOfBytes: "32",
    },
    t_uint128: {
      encoding: "inplace",
      label: "uint128",
      numberOfBytes: "16",
    },
    "t_array(t_uint128)3_storage": {
      base: "t_uint128",
      encoding: "inplace",
      label: "uint128[3]",
      numberOfBytes: "64",
    },
    t_bytes_storage: {
      encoding: "bytes",
      label: "bytes",
      numberOfBytes: "32",
    },
    t_string_storage: {
      encoding: "bytes",
      label: "string",
      numberOfBytes: "32",
    },
  },
} as const satisfies StorageLayout;

test("decodeStorageDiff infers strict sparse concrete variable keys and values", () => {
  const diff = decodeStorageDiff(layout, { pre: {}, post: {} });

  expectTypeOf(diff).toEqualTypeOf<StorageVariableDiff<typeof layout>>();
});

test("decodeStorageDiff accepts only concrete known variables", () => {
  const typeAssertions = () => {
    decodeStorageDiff(layout, { pre: {}, post: {} });
    decodeStorageDiff(layout, { pre: {}, post: {} }, ["supply"]);
    decodeStorageDiff(layout, { pre: {}, post: {} }, [
      "metadata.lastUpdate",
      "fixedNumbers[0]",
      `balances[${"0x123" as Hex.Hex}]`,
    ]);

    // @ts-expect-error structs are not concrete leaf paths
    decodeStorageDiff(layout, { pre: {}, post: {} }, ["metadata"]);
    // @ts-expect-error fixed array roots are not concrete leaf paths
    decodeStorageDiff(layout, { pre: {}, post: {} }, ["fixedNumbers"]);
    // @ts-expect-error dynamic array roots are not concrete leaf paths
    decodeStorageDiff(layout, { pre: {}, post: {} }, ["numbers"]);
    // @ts-expect-error mappings require keys
    decodeStorageDiff(layout, { pre: {}, post: {} }, ["balances"]);
    decodeStorageDiff(layout, { pre: {}, post: {} }, [
      // @ts-expect-error nested mappings require all keys to reach a leaf
      `allowances[${"0x123" as Hex.Hex}]`,
    ]);
    // @ts-expect-error fixed array index is out of bounds
    decodeStorageDiff(layout, { pre: {}, post: {} }, ["fixedNumbers[3]"]);
  };

  expectTypeOf(typeAssertions).toEqualTypeOf<() => void>();
});

test("decodeStorageDiff gracefully falls back for loose layouts", () => {
  const typeAssertions = () => {
    const looseLayout = {} as StorageLayout;
    const diff = decodeStorageDiff(looseLayout, { pre: {}, post: {} });

    expectTypeOf(diff).toEqualTypeOf<StorageVariableDiff<StorageLayout>>();
  };

  expectTypeOf(typeAssertions).toEqualTypeOf<() => void>();
});
