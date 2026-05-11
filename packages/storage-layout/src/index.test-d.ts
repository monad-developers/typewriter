import { expectTypeOf, test } from "bun:test";
import type {
  ExtractMappingType,
  ExtractMappingVariableNames,
  ExtractVariableNames,
  IsSingleSlot,
  IsVariableSingleSlot,
  StorageLayout,
  StorageLayoutToVariableType,
  StorageLayoutToVariableTypes,
  StoragePathToPrimitiveType,
} from "./index";
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

test("StorageLayoutToVariableTypes maps top-level Solidity types", () => {
  type Variables = StorageLayoutToVariableTypes<typeof layout>;

  expectTypeOf<Variables>().toEqualTypeOf<{
    supply: bigint;
    flags: number;
    owner: `0x${string}`;
    metadata: { lastUpdate: bigint; paused: boolean };
    numbers: readonly bigint[];
    balances: [`Error: Unsupported type 'mapping(address => uint256)'.`];
  }>();
});

test("StorageLayoutToVariableType extracts one variable", () => {
  type Metadata = StorageLayoutToVariableType<typeof layout, "metadata">;

  expectTypeOf<Metadata>().toEqualTypeOf<{
    lastUpdate: bigint;
    paused: boolean;
  }>();
});

test("StoragePathToPrimitiveType handles top-level path selectors", () => {
  type Owner = StoragePathToPrimitiveType<typeof layout, "owner">;
  type SupplyPath = StoragePathToPrimitiveType<
    typeof layout,
    { root: "supply"; segments: readonly [] }
  >;
  type Nested = StoragePathToPrimitiveType<
    typeof layout,
    "metadata.lastUpdate"
  >;
  type NestedPath = StoragePathToPrimitiveType<
    typeof layout,
    {
      root: "metadata";
      segments: readonly [{ kind: "field"; name: "paused" }];
    }
  >;

  expectTypeOf<Owner>().toEqualTypeOf<`0x${string}`>();
  expectTypeOf<SupplyPath>().toEqualTypeOf<bigint>();
  expectTypeOf<Nested>().toEqualTypeOf<bigint>();
  expectTypeOf<NestedPath>().toEqualTypeOf<boolean>();
});

test("storage layout extraction helpers preserve layout names", () => {
  type Names = ExtractVariableNames<typeof layout>;
  type MappingNames = ExtractMappingVariableNames<typeof layout>;
  type MappingKey = ExtractMappingType<typeof layout, "balances", "key">;

  expectTypeOf<Names>().toEqualTypeOf<
    "supply" | "flags" | "owner" | "metadata" | "numbers" | "balances"
  >();
  expectTypeOf<MappingNames>().toEqualTypeOf<"balances">();
  expectTypeOf<MappingKey>().toEqualTypeOf<`0x${string}`>();
});

test("IsVariableSingleSlot follows storage layout byte counts", () => {
  expectTypeOf<
    IsVariableSingleSlot<typeof layout, "supply">
  >().toEqualTypeOf<true>();
  expectTypeOf<
    IsVariableSingleSlot<typeof layout, "metadata">
  >().toEqualTypeOf<true>();
});

test("getStorageSlot return type follows IsSingleSlot", () => {
  const ownerSlot = getStorageSlot(layout, "owner");
  const metadataSlot = getStorageSlot(layout, "metadata");
  const multiSlotMetadata = getStorageSlot(multiSlotLayout, "metadata");

  expectTypeOf<IsSingleSlot<typeof layout, "owner">>().toEqualTypeOf<true>();
  expectTypeOf<
    IsSingleSlot<typeof layout, "metadata.lastUpdate">
  >().toEqualTypeOf<true>();
  expectTypeOf<
    IsSingleSlot<typeof multiSlotLayout, "metadata">
  >().toEqualTypeOf<false>();
  expectTypeOf(ownerSlot).toEqualTypeOf<`0x${string}`>();
  expectTypeOf(metadataSlot).toEqualTypeOf<`0x${string}`>();
  expectTypeOf(multiSlotMetadata).toEqualTypeOf<`0x${string}`[]>();
});
