import type { Hex } from "ox";
import type { SlotWrites, StorageLayout } from "../src/index";

export const OWNER = "0x1111111111111111111111111111111111111234" as const;
export const SPENDER = "0x2222222222222222222222222222222222221234" as const;
export const PACKED_OWNER_PAUSED =
  `0x${"00".repeat(11)}01${OWNER.slice(2)}` as Hex.Hex;
export const PACKED_OWNER_UNPAUSED =
  `0x${"00".repeat(12)}${OWNER.slice(2)}` as Hex.Hex;
export const PACKED_FIXED_NUMBERS =
  "0x0000000000000000000000000000000200000000000000000000000000000001" as Hex.Hex;
export const SALT = `0x${"ff".repeat(32)}` as Hex.Hex;
export const METADATA_PACKED =
  `0x${"00".repeat(23)}01${"00".repeat(7)}2a` as Hex.Hex;

export type SlotMap = { [slot: Hex.Hex]: Hex.Hex };

export function expectSingleSlot(slots: readonly Hex.Hex[]): Hex.Hex {
  if (slots.length !== 1) {
    throw new Error("expected a single slot");
  }
  return slots[0]!;
}

export function writesToStorage(writes: SlotWrites): SlotMap {
  return Object.fromEntries(
    Object.entries(writes).map(([slot, write]) => [slot, write.value]),
  );
}

export const layout = {
  storage: [
    {
      astId: 1,
      contract: "src/Test.sol:Test",
      label: "totalSupply",
      offset: 0,
      slot: "0",
      type: "t_uint256",
    },
    {
      astId: 2,
      contract: "src/Test.sol:Test",
      label: "owner",
      offset: 0,
      slot: "1",
      type: "t_address",
    },
    {
      astId: 3,
      contract: "src/Test.sol:Test",
      label: "paused",
      offset: 20,
      slot: "1",
      type: "t_bool",
    },
    {
      astId: 4,
      contract: "src/Test.sol:Test",
      label: "debt",
      offset: 0,
      slot: "2",
      type: "t_int16",
    },
    {
      astId: 5,
      contract: "src/Test.sol:Test",
      label: "salt",
      offset: 0,
      slot: "3",
      type: "t_bytes32",
    },
    {
      astId: 6,
      contract: "src/Test.sol:Test",
      label: "metadata",
      offset: 0,
      slot: "4",
      type: "t_struct(Metadata)20_storage",
    },
    {
      astId: 7,
      contract: "src/Test.sol:Test",
      label: "balances",
      offset: 0,
      slot: "7",
      type: "t_mapping(t_address,t_uint256)",
    },
    {
      astId: 13,
      contract: "src/Test.sol:Test",
      label: "fixedNumbers",
      offset: 0,
      slot: "8",
      type: "t_array(t_uint128)3_storage",
    },
    {
      astId: 14,
      contract: "src/Test.sol:Test",
      label: "dynamicNumbers",
      offset: 0,
      slot: "10",
      type: "t_array(t_uint256)dyn_storage",
    },
    {
      astId: 15,
      contract: "src/Test.sol:Test",
      label: "rawBytes",
      offset: 0,
      slot: "11",
      type: "t_bytes_storage",
    },
    {
      astId: 16,
      contract: "src/Test.sol:Test",
      label: "message",
      offset: 0,
      slot: "12",
      type: "t_string_storage",
    },
    {
      astId: 17,
      contract: "src/Test.sol:Test",
      label: "allowances",
      offset: 0,
      slot: "13",
      type: "t_mapping(t_address,t_mapping(t_address,t_uint256))",
    },
  ],
  types: {
    t_address: {
      encoding: "inplace",
      label: "address",
      numberOfBytes: "20",
    },
    t_bool: {
      encoding: "inplace",
      label: "bool",
      numberOfBytes: "1",
    },
    t_bytes32: {
      encoding: "inplace",
      label: "bytes32",
      numberOfBytes: "32",
    },
    t_int16: {
      encoding: "inplace",
      label: "int16",
      numberOfBytes: "2",
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
    "t_struct(Inner)19_storage": {
      encoding: "inplace",
      label: "struct Test.Inner",
      members: [
        {
          astId: 11,
          contract: "src/Test.sol:Test",
          label: "count",
          offset: 0,
          slot: "0",
          type: "t_uint256",
        },
      ],
      numberOfBytes: "32",
    },
    "t_struct(Metadata)20_storage": {
      encoding: "inplace",
      label: "struct Test.Metadata",
      members: [
        {
          astId: 8,
          contract: "src/Test.sol:Test",
          label: "lastUpdate",
          offset: 0,
          slot: "0",
          type: "t_uint64",
        },
        {
          astId: 9,
          contract: "src/Test.sol:Test",
          label: "active",
          offset: 8,
          slot: "0",
          type: "t_bool",
        },
        {
          astId: 10,
          contract: "src/Test.sol:Test",
          label: "admin",
          offset: 0,
          slot: "1",
          type: "t_address",
        },
        {
          astId: 12,
          contract: "src/Test.sol:Test",
          label: "inner",
          offset: 0,
          slot: "2",
          type: "t_struct(Inner)19_storage",
        },
      ],
      numberOfBytes: "96",
    },
    t_uint256: {
      encoding: "inplace",
      label: "uint256",
      numberOfBytes: "32",
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
    "t_array(t_uint128)3_storage": {
      base: "t_uint128",
      encoding: "inplace",
      label: "uint128[3]",
      numberOfBytes: "64",
    },
    "t_array(t_uint256)dyn_storage": {
      base: "t_uint256",
      encoding: "dynamic_array",
      label: "uint256[]",
      numberOfBytes: "32",
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

export const complexLayout = {
  storage: [
    {
      astId: 30,
      contract: "src/Test.sol:Test",
      label: "orders",
      offset: 0,
      slot: "0",
      type: "t_array(t_struct(Order)31_storage)2_storage",
    },
    {
      astId: 40,
      contract: "src/Test.sol:Test",
      label: "book",
      offset: 0,
      slot: "10",
      type: "t_struct(Book)40_storage",
    },
    {
      astId: 50,
      contract: "src/Test.sol:Test",
      label: "matrix",
      offset: 0,
      slot: "20",
      type: "t_array(t_array(t_uint128)2_storage)2_storage",
    },
  ],
  types: {
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
    "t_array(t_struct(Order)31_storage)2_storage": {
      base: "t_struct(Order)31_storage",
      encoding: "inplace",
      label: "struct Test.Order[2]",
      numberOfBytes: "128",
    },
    "t_array(t_uint128)2_storage": {
      base: "t_uint128",
      encoding: "inplace",
      label: "uint128[2]",
      numberOfBytes: "32",
    },
    "t_array(t_array(t_uint128)2_storage)2_storage": {
      base: "t_array(t_uint128)2_storage",
      encoding: "inplace",
      label: "uint128[2][2]",
      numberOfBytes: "64",
    },
    "t_struct(Book)40_storage": {
      encoding: "inplace",
      label: "struct Test.Book",
      members: [
        {
          astId: 41,
          contract: "src/Test.sol:Test",
          label: "priceLevels",
          offset: 0,
          slot: "0",
          type: "t_array(t_uint128)2_storage",
        },
        {
          astId: 42,
          contract: "src/Test.sol:Test",
          label: "inner",
          offset: 0,
          slot: "1",
          type: "t_struct(Inner)43_storage",
        },
      ],
      numberOfBytes: "64",
    },
    "t_struct(Inner)43_storage": {
      encoding: "inplace",
      label: "struct Test.Inner",
      members: [
        {
          astId: 43,
          contract: "src/Test.sol:Test",
          label: "count",
          offset: 0,
          slot: "0",
          type: "t_uint256",
        },
      ],
      numberOfBytes: "32",
    },
    "t_struct(Order)31_storage": {
      encoding: "inplace",
      label: "struct Test.Order",
      members: [
        {
          astId: 31,
          contract: "src/Test.sol:Test",
          label: "price",
          offset: 0,
          slot: "0",
          type: "t_uint256",
        },
        {
          astId: 32,
          contract: "src/Test.sol:Test",
          label: "amount",
          offset: 0,
          slot: "1",
          type: "t_uint256",
        },
      ],
      numberOfBytes: "64",
    },
  },
} as const satisfies StorageLayout;
