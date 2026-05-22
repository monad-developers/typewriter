import { expectTypeOf, test } from "bun:test";
import type { Hex } from "ox";
import type {
  ConcreteStorageVariable,
  ExtractVariableNames,
  StorageLayout,
  StorageLayoutToPrimitiveType,
  StorageSlotDiff,
  StorageSlotWriteDiff,
  StorageVariable,
  StorageVariableDiff,
  StorageVariableToPrimitiveType,
} from "./index";
import { decodeStorageVariable, encodeStorageVariable } from "./index";
import type { ParseStoragePath } from "./storage-path";

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

test("type-level storage path parsing matches runtime path shape", () => {
  type Parsed = ParseStoragePath<"accounts[0xabcd][1].orders[3][4].price">;

  expectTypeOf<Parsed>().toEqualTypeOf<{
    root: "accounts";
    segments: readonly [
      { kind: "subscript" },
      { kind: "subscript" },
      { kind: "field"; name: "orders" },
      { kind: "subscript" },
      { kind: "subscript" },
      { kind: "field"; name: "price" },
    ];
  }>();
});

test("StorageLayoutToPrimitiveType maps top-level Solidity types", () => {
  type Variables = StorageLayoutToPrimitiveType<typeof layout>;

  expectTypeOf<Variables>().toEqualTypeOf<{
    supply: bigint;
    flags: number;
    owner: `0x${string}`;
    metadata: { lastUpdate: bigint; paused: boolean };
    numbers: readonly bigint[];
    balances: Record<Hex.Hex, bigint>;
    allowances: Record<Hex.Hex, Record<Hex.Hex, bigint>>;
    fixedNumbers: readonly [bigint, bigint, bigint];
    rawBytes: `0x${string}`;
    message: string;
  }>();
});

test("StorageLayoutToPrimitiveType falls back for broad StorageLayout", () => {
  type Variables = StorageLayoutToPrimitiveType<StorageLayout>;

  expectTypeOf<Variables>().toEqualTypeOf<Record<string, unknown>>();
});

test("StorageLayoutToPrimitiveType remains writable plain data", () => {
  type Variables = StorageLayoutToPrimitiveType<typeof layout>;

  expectTypeOf<Variables["metadata"]>().toEqualTypeOf<{
    lastUpdate: bigint;
    paused: boolean;
  }>();
});

test("StorageVariableToPrimitiveType extracts one variable", () => {
  type Metadata = StorageVariableToPrimitiveType<typeof layout, "metadata">;

  expectTypeOf<Metadata>().toEqualTypeOf<{
    lastUpdate: bigint;
    paused: boolean;
  }>();
});

test("StorageVariableToPrimitiveType handles top-level variable selectors", () => {
  type Owner = StorageVariableToPrimitiveType<typeof layout, "owner">;
  type Nested = StorageVariableToPrimitiveType<
    typeof layout,
    "metadata.lastUpdate"
  >;
  type FixedArrayElement = StorageVariableToPrimitiveType<
    typeof layout,
    "fixedNumbers[0]"
  >;
  type DynamicArray = StorageVariableToPrimitiveType<typeof layout, "numbers">;
  type DynamicArrayElement = StorageVariableToPrimitiveType<
    typeof layout,
    "numbers[0]"
  >;
  type MappingValue = StorageVariableToPrimitiveType<
    typeof layout,
    `balances[${Hex.Hex}]`
  >;
  type NestedMappingValue = StorageVariableToPrimitiveType<
    typeof layout,
    `allowances[${Hex.Hex}][${Hex.Hex}]`
  >;
  type RawBytes = StorageVariableToPrimitiveType<typeof layout, "rawBytes">;
  type Message = StorageVariableToPrimitiveType<typeof layout, "message">;

  expectTypeOf<Owner>().toEqualTypeOf<`0x${string}`>();
  expectTypeOf<Nested>().toEqualTypeOf<bigint>();
  expectTypeOf<FixedArrayElement>().toEqualTypeOf<bigint>();
  expectTypeOf<DynamicArray>().toEqualTypeOf<readonly bigint[]>();
  expectTypeOf<DynamicArrayElement>().toEqualTypeOf<bigint>();
  expectTypeOf<MappingValue>().toEqualTypeOf<bigint>();
  expectTypeOf<NestedMappingValue>().toEqualTypeOf<bigint>();
  expectTypeOf<RawBytes>().toEqualTypeOf<`0x${string}`>();
  expectTypeOf<Message>().toEqualTypeOf<string>();
});

test("StorageVariableDiff infers sparse concrete variable keys and values", () => {
  type Diff = StorageVariableDiff<typeof layout>;

  expectTypeOf<Diff["pre"]["owner"]>().toEqualTypeOf<
    `0x${string}` | undefined
  >();
  expectTypeOf<Diff["post"]["metadata.lastUpdate"]>().toEqualTypeOf<
    bigint | undefined
  >();
  expectTypeOf<Diff["pre"][`balances[${Hex.Hex}]`]>().toEqualTypeOf<
    bigint | undefined
  >();
});

test("StorageSlotDiff uses raw slot values and StorageSlotWriteDiff uses masks", () => {
  expectTypeOf<StorageSlotDiff["pre"]>().toEqualTypeOf<{
    [slot: Hex.Hex]: Hex.Hex;
  }>();
  expectTypeOf<StorageSlotWriteDiff["pre"]>().toEqualTypeOf<{
    [slot: Hex.Hex]: { value: Hex.Hex; mask: Hex.Hex };
  }>();
});

test("public storage variable types preserve layout names", () => {
  type Names = ExtractVariableNames<typeof layout>;
  type Variables = StorageVariable<typeof layout>;
  type ConcreteVariables = ConcreteStorageVariable<typeof layout>;

  expectTypeOf<Names>().toEqualTypeOf<
    | "supply"
    | "flags"
    | "owner"
    | "metadata"
    | "numbers"
    | "balances"
    | "allowances"
    | "fixedNumbers"
    | "rawBytes"
    | "message"
  >();
  expectTypeOf<Variables>().toEqualTypeOf<
    | "supply"
    | "flags"
    | "owner"
    | "metadata"
    | "metadata.lastUpdate"
    | "metadata.paused"
    | "numbers"
    | `numbers[${number}]`
    | `balances[${Hex.Hex}]`
    | `allowances[${Hex.Hex}][${Hex.Hex}]`
    | "fixedNumbers"
    | "fixedNumbers[0]"
    | "fixedNumbers[1]"
    | "fixedNumbers[2]"
    | "rawBytes"
    | "message"
  >();
  expectTypeOf<ConcreteVariables>().toEqualTypeOf<
    | "supply"
    | "flags"
    | "owner"
    | "metadata.lastUpdate"
    | "metadata.paused"
    | `numbers[${number}]`
    | `balances[${Hex.Hex}]`
    | `allowances[${Hex.Hex}][${Hex.Hex}]`
    | "fixedNumbers[0]"
    | "fixedNumbers[1]"
    | "fixedNumbers[2]"
    | "rawBytes"
    | "message"
  >();
});

test("concrete path APIs reject composite paths at type-check time", () => {
  const typeAssertions = () => {
    decodeStorageVariable(layout, "owner", {});
    encodeStorageVariable(layout, "metadata.paused", false);

    // @ts-expect-error structs are not concrete leaf paths
    decodeStorageVariable(layout, "metadata", {});
    // @ts-expect-error dynamic array roots are not concrete leaf paths
    decodeStorageVariable(layout, "numbers", {});
    // @ts-expect-error fixed array roots are not concrete leaf paths
    encodeStorageVariable(layout, "fixedNumbers", [1n, 2n, 3n]);
    // @ts-expect-error nested mappings require all keys to reach a leaf
    decodeStorageVariable(layout, `allowances[${"0x123" as Hex.Hex}]`, {});
  };
  expectTypeOf(typeAssertions).toEqualTypeOf<() => void>();
});
