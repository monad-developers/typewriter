import type { HexString, StorageLayout } from "../src/index";

export const OWNER = "0x1111111111111111111111111111111111111234" as const;
export const PACKED_OWNER_PAUSED =
  `0x${"00".repeat(11)}01${OWNER.slice(2)}` as HexString;
export const PACKED_OWNER_UNPAUSED =
  `0x${"00".repeat(12)}${OWNER.slice(2)}` as HexString;
export const SALT = `0x${"ff".repeat(32)}` as HexString;
export const METADATA_PACKED =
  `0x${"00".repeat(23)}01${"00".repeat(7)}2a` as HexString;

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
  },
} as const satisfies StorageLayout;
