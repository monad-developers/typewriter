import type { StorageLayout } from "storage-layout";

export const TOKEN_STORAGE_LAYOUT = {
  storage: [
    {
      astId: 1,
      contract: "src/Token.sol:Token",
      label: "totalSupply",
      offset: 0,
      slot: "1",
      type: "t_uint256",
    },
    {
      astId: 2,
      contract: "src/Token.sol:Token",
      label: "accounts",
      offset: 0,
      slot: "2",
      type: "t_mapping(t_address,t_struct(Account)_storage)",
    },
  ],
  types: {
    t_address: { encoding: "inplace", label: "address", numberOfBytes: "20" },
    "t_mapping(t_address,t_struct(Account)_storage)": {
      encoding: "mapping",
      key: "t_address",
      label: "mapping(address => struct Account)",
      numberOfBytes: "32",
      value: "t_struct(Account)_storage",
    },
    "t_struct(Account)_storage": {
      encoding: "inplace",
      label: "struct Account",
      numberOfBytes: "64",
      members: [
        {
          astId: 3,
          contract: "src/Token.sol:Token",
          label: "nonce",
          offset: 0,
          slot: "0",
          type: "t_uint256",
        },
        {
          astId: 4,
          contract: "src/Token.sol:Token",
          label: "balance",
          offset: 0,
          slot: "1",
          type: "t_uint256",
        },
      ],
    },
    t_uint256: { encoding: "inplace", label: "uint256", numberOfBytes: "32" },
  },
} as const satisfies StorageLayout;
