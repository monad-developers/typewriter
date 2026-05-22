import { expectTypeOf, test } from "bun:test";
import type { Hex } from "ox";
import type { StorageLayout, StorageSlotWriteDiff } from "./index";
import { encodeStorageDiff } from "./index";

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

test("encodeStorageDiff infers strict sparse concrete variable keys and values", () => {
  const diff = encodeStorageDiff(layout, {
    pre: { supply: 1n, owner: "0x123" as Hex.Hex },
    post: { supply: 2n, "metadata.paused": true },
  });

  expectTypeOf(diff).toEqualTypeOf<StorageSlotWriteDiff>();
});

test("encodeStorageDiff values are inferred from storage variable paths", () => {
  const typeAssertions = () => {
    encodeStorageDiff(layout, {
      pre: { supply: 1n },
      post: { owner: "0x123" as Hex.Hex },
    });
    encodeStorageDiff(layout, {
      pre: { "metadata.paused": true },
      post: { rawBytes: "0x1234" },
    });
    encodeStorageDiff(layout, {
      pre: { message: "hello" },
      post: {},
    });

    // @ts-expect-error uint256 values are bigints
    encodeStorageDiff(layout, { pre: { supply: 1 }, post: {} });
    // @ts-expect-error bool values are booleans
    encodeStorageDiff(layout, { pre: { "metadata.paused": 1n }, post: {} });
    // @ts-expect-error bytes values are hex strings
    encodeStorageDiff(layout, { pre: { rawBytes: 1n }, post: {} });
    // @ts-expect-error string values are strings
    encodeStorageDiff(layout, { pre: { message: 1n }, post: {} });
  };

  expectTypeOf(typeAssertions).toEqualTypeOf<() => void>();
});

test("encodeStorageDiff only accepts concrete leaf variables", () => {
  const typeAssertions = () => {
    encodeStorageDiff(layout, { pre: { supply: 1n }, post: {} });
    encodeStorageDiff(layout, { pre: { "metadata.lastUpdate": 1n }, post: {} });
    encodeStorageDiff(layout, { pre: { "fixedNumbers[0]": 1n }, post: {} });
    encodeStorageDiff(layout, { pre: { "numbers[0]": 1n }, post: {} });
    encodeStorageDiff(layout, {
      pre: { [`balances[${"0x123" as Hex.Hex}]`]: 1n },
      post: {},
    });

    // @ts-expect-error structs are not concrete leaf paths
    encodeStorageDiff(layout, { pre: { metadata: {} }, post: {} });
    // @ts-expect-error fixed array roots are not concrete leaf paths
    encodeStorageDiff(layout, { pre: { fixedNumbers: [] }, post: {} });
    // @ts-expect-error dynamic array roots are not concrete leaf paths
    encodeStorageDiff(layout, { pre: { numbers: [] }, post: {} });
    // @ts-expect-error mappings require keys
    encodeStorageDiff(layout, { pre: { balances: {} }, post: {} });
    encodeStorageDiff(layout, {
      // @ts-expect-error nested mappings require all keys to reach a leaf
      pre: { [`allowances[${"0x123" as Hex.Hex}]`]: {} },
      post: {},
    });
    // @ts-expect-error fixed array index is out of bounds
    encodeStorageDiff(layout, { pre: { "fixedNumbers[3]": 1n }, post: {} });
  };

  expectTypeOf(typeAssertions).toEqualTypeOf<() => void>();
});

test("encodeStorageDiff gracefully falls back for loose layouts", () => {
  const typeAssertions = () => {
    const looseLayout = {} as StorageLayout;
    const diff = encodeStorageDiff(looseLayout, {
      pre: { anything: "value" },
      post: {},
    });

    expectTypeOf(diff).toEqualTypeOf<StorageSlotWriteDiff>();
  };

  expectTypeOf(typeAssertions).toEqualTypeOf<() => void>();
});
