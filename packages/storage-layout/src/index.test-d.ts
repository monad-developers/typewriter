import { expectTypeOf, test } from "bun:test";
import type { Hex } from "ox";
import type {
  DeepPromise,
  ExtractConcreteStoragePaths,
  ExtractMultiSlotStoragePaths,
  ExtractStoragePaths,
  ExtractVariableNames,
  IsSingleSlot,
  SlotMap,
  StorageLayout,
  StorageLayoutToPrimitiveType,
  StoragePathToPrimitiveType,
  StorageProxy,
} from "./index";
import {
  createStorageProxy,
  decodeStoragePath,
  encodeStoragePath,
  getStorageSlot,
} from "./index";
import type {
  FormatStoragePath,
  NormalizeStoragePath,
  ParseStoragePath,
} from "./storage-path";

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

test("type-level storage path helpers match runtime path shape", () => {
  type Parsed = ParseStoragePath<"accounts[0xabcd][1].orders[3][4].price">;
  type Formatted = FormatStoragePath<{
    root: "accounts";
    segments: readonly [
      { kind: "subscript"; value: { kind: "hex"; value: "0xabcd" } },
      { kind: "field"; name: "orders" },
      { kind: "subscript"; value: { kind: "number"; value: 3n } },
    ];
  }>;
  type Normalized = NormalizeStoragePath<{
    root: "accounts";
    segments: readonly [
      { kind: "subscript"; value: { kind: "hex"; value: "0xabcd" } },
      { kind: "field"; name: "orders" },
      { kind: "subscript"; value: { kind: "number"; value: 3n } },
    ];
  }>;

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
  expectTypeOf<Formatted>().toEqualTypeOf<"accounts[0xabcd].orders[3]">();
  expectTypeOf<Normalized>().toEqualTypeOf<{
    root: "accounts";
    segments: readonly [
      { kind: "subscript" },
      { kind: "field"; name: "orders" },
      { kind: "subscript" },
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

test("StorageProxy follows sync and async getter shapes", () => {
  const syncGetter = (_slots: Hex.Hex[]): SlotMap => ({});
  const asyncGetter = async (_slots: Hex.Hex[]): Promise<SlotMap> => ({});
  const syncState = createStorageProxy(layout, syncGetter);
  const asyncState = createStorageProxy(layout, asyncGetter);

  expectTypeOf(syncState).toEqualTypeOf<
    StorageProxy<typeof layout, typeof syncGetter>
  >();
  expectTypeOf(syncState.metadata).toEqualTypeOf<{
    readonly lastUpdate: bigint;
    readonly paused: boolean;
  }>();
  expectTypeOf(syncState.balances).toEqualTypeOf<{
    readonly [K: Hex.Hex]: bigint;
  }>();
  expectTypeOf(syncState.allowances).toEqualTypeOf<{
    readonly [K: Hex.Hex]: { readonly [K: Hex.Hex]: bigint };
  }>();
  expectTypeOf(syncState.fixedNumbers).toEqualTypeOf<
    readonly [bigint, bigint, bigint]
  >();

  expectTypeOf(asyncState).toEqualTypeOf<
    StorageProxy<typeof layout, typeof asyncGetter>
  >();
  expectTypeOf(asyncState.supply).toEqualTypeOf<Promise<bigint>>();
  expectTypeOf(asyncState.metadata).toEqualTypeOf<{
    readonly lastUpdate: Promise<bigint>;
    readonly paused: Promise<boolean>;
  }>();
  expectTypeOf(asyncState.balances).toEqualTypeOf<{
    readonly [K: Hex.Hex]: Promise<bigint>;
  }>();
  expectTypeOf(asyncState.allowances).toEqualTypeOf<{
    readonly [K: Hex.Hex]: { readonly [K: Hex.Hex]: Promise<bigint> };
  }>();
  expectTypeOf(asyncState.fixedNumbers).toEqualTypeOf<
    readonly [Promise<bigint>, Promise<bigint>, Promise<bigint>]
  >();
  expectTypeOf<(typeof asyncState.fixedNumbers)["length"]>().toEqualTypeOf<3>();
  expectTypeOf(asyncState.numbers).toEqualTypeOf<readonly Promise<bigint>[]>();
});

test("DeepPromise preserves readonly composite structure", () => {
  type AsyncVariables = DeepPromise<
    StorageLayoutToPrimitiveType<typeof layout>
  >;

  expectTypeOf<AsyncVariables["metadata"]>().toEqualTypeOf<{
    readonly lastUpdate: Promise<bigint>;
    readonly paused: Promise<boolean>;
  }>();
  expectTypeOf<AsyncVariables["fixedNumbers"]>().toEqualTypeOf<
    readonly [Promise<bigint>, Promise<bigint>, Promise<bigint>]
  >();
  expectTypeOf<AsyncVariables["fixedNumbers"]["length"]>().toEqualTypeOf<3>();
});

test("StorageLayoutToPrimitiveType remains writable plain data", () => {
  type Variables = StorageLayoutToPrimitiveType<typeof layout>;

  expectTypeOf<Variables["metadata"]>().toEqualTypeOf<{
    lastUpdate: bigint;
    paused: boolean;
  }>();
});

test("StoragePathToPrimitiveType extracts one variable", () => {
  type Metadata = StoragePathToPrimitiveType<typeof layout, "metadata">;

  expectTypeOf<Metadata>().toEqualTypeOf<{
    lastUpdate: bigint;
    paused: boolean;
  }>();
});

test("StoragePathToPrimitiveType handles top-level path selectors", () => {
  type Owner = StoragePathToPrimitiveType<typeof layout, "owner">;
  type Nested = StoragePathToPrimitiveType<
    typeof layout,
    "metadata.lastUpdate"
  >;
  type FixedArrayElement = StoragePathToPrimitiveType<
    typeof layout,
    "fixedNumbers[0]"
  >;
  type DynamicArray = StoragePathToPrimitiveType<typeof layout, "numbers">;
  type DynamicArrayElement = StoragePathToPrimitiveType<
    typeof layout,
    "numbers[0]"
  >;
  type MappingValue = StoragePathToPrimitiveType<
    typeof layout,
    `balances[${Hex.Hex}]`
  >;
  type NestedMappingValue = StoragePathToPrimitiveType<
    typeof layout,
    `allowances[${Hex.Hex}][${Hex.Hex}]`
  >;
  type RawBytes = StoragePathToPrimitiveType<typeof layout, "rawBytes">;
  type Message = StoragePathToPrimitiveType<typeof layout, "message">;

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

test("storage layout extraction helpers preserve layout names", () => {
  type Names = ExtractVariableNames<typeof layout>;
  type Paths = ExtractStoragePaths<typeof layout>;
  type ConcretePaths = ExtractConcreteStoragePaths<typeof layout>;
  type MultiSlotPaths = ExtractMultiSlotStoragePaths<typeof layout>;

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
  expectTypeOf<Paths>().toEqualTypeOf<
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
  expectTypeOf<ConcretePaths>().toEqualTypeOf<
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
  expectTypeOf<MultiSlotPaths>().toEqualTypeOf<"fixedNumbers">();
});

test("concrete path APIs reject composite paths at type-check time", () => {
  const typeAssertions = () => {
    getStorageSlot(layout, "metadata");
    getStorageSlot(layout, "numbers");
    decodeStoragePath(layout, "owner", {});
    encodeStoragePath(layout, "metadata.paused", false);

    // @ts-expect-error unknown roots are not storage paths
    getStorageSlot(layout, "missing");
    // @ts-expect-error mappings require keys
    getStorageSlot(layout, "balances");
    // @ts-expect-error fixed array index is out of bounds
    getStorageSlot(layout, "fixedNumbers[3]");

    // @ts-expect-error structs are not concrete leaf paths
    decodeStoragePath(layout, "metadata", {});
    // @ts-expect-error dynamic array roots are not concrete leaf paths
    decodeStoragePath(layout, "numbers", {});
    // @ts-expect-error fixed array roots are not concrete leaf paths
    encodeStoragePath(layout, "fixedNumbers", [1n, 2n, 3n]);
    // @ts-expect-error nested mappings require all keys to reach a leaf
    decodeStoragePath(layout, `allowances[${"0x123" as Hex.Hex}]`, {});
  };
  expectTypeOf(typeAssertions).toEqualTypeOf<() => void>();
});

test("getStorageSlot accepts inferred storage paths", () => {
  const ownerSlot = getStorageSlot(layout, "owner");
  const metadataSlot = getStorageSlot(layout, "metadata");
  const dynamicNumbersSlot = getStorageSlot(layout, "numbers");
  const fixedNumbersSlot = getStorageSlot(layout, "fixedNumbers");
  const multiSlotMetadata = getStorageSlot(multiSlotLayout, "metadata");

  expectTypeOf<IsSingleSlot<typeof layout, "owner">>().toEqualTypeOf<true>();
  expectTypeOf<
    IsSingleSlot<typeof layout, "metadata.lastUpdate">
  >().toEqualTypeOf<true>();
  expectTypeOf<
    IsSingleSlot<typeof layout, "fixedNumbers[0]">
  >().toEqualTypeOf<true>();
  expectTypeOf<IsSingleSlot<typeof layout, "numbers">>().toEqualTypeOf<true>();
  expectTypeOf<
    IsSingleSlot<typeof layout, "fixedNumbers">
  >().toEqualTypeOf<false>();
  expectTypeOf<
    IsSingleSlot<typeof multiSlotLayout, "metadata">
  >().toEqualTypeOf<false>();
  expectTypeOf(ownerSlot).toEqualTypeOf<`0x${string}`>();
  expectTypeOf(metadataSlot).toEqualTypeOf<`0x${string}`>();
  expectTypeOf(dynamicNumbersSlot).toEqualTypeOf<`0x${string}`>();
  expectTypeOf(fixedNumbersSlot).toEqualTypeOf<`0x${string}`[]>();
  expectTypeOf(multiSlotMetadata).toEqualTypeOf<`0x${string}`[]>();
});
