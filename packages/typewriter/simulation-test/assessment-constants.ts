import type { TypewriterSolidityEntrypoint } from "../src";

export const STORAGE_LAYOUT = {
  storage: [
    {
      astId: 695,
      contract: "src/Assessment.sol:Assessment",
      label: "accounts",
      offset: 0,
      slot: "0",
      type: "t_mapping(t_bytes32,t_struct(Account)26_storage)",
    },
    {
      astId: 699,
      contract: "src/Assessment.sol:Assessment",
      label: "queue",
      offset: 0,
      slot: "1",
      type: "t_array(t_struct(QueuedMutation)657_storage)dyn_storage",
    },
    {
      astId: 701,
      contract: "src/Assessment.sol:Assessment",
      label: "executionIndex",
      offset: 0,
      slot: "2",
      type: "t_uint256",
    },
    {
      astId: 1858,
      contract: "src/Assessment.sol:Assessment",
      label: "state",
      offset: 0,
      slot: "3",
      type: "t_struct(State)1551_storage",
    },
  ],
  types: {
    "t_array(t_struct(Credential)15_storage)dyn_storage": {
      encoding: "dynamic_array",
      label: "struct Credential[]",
      numberOfBytes: "32",
      base: "t_struct(Credential)15_storage",
    },
    "t_array(t_struct(QueuedMutation)657_storage)dyn_storage": {
      encoding: "dynamic_array",
      label: "struct Typewriter.QueuedMutation[]",
      numberOfBytes: "32",
      base: "t_struct(QueuedMutation)657_storage",
    },
    t_bytes32: {
      encoding: "inplace",
      label: "bytes32",
      numberOfBytes: "32",
    },
    t_bytes_storage: {
      encoding: "bytes",
      label: "bytes",
      numberOfBytes: "32",
    },
    "t_enum(KeyType)5": {
      encoding: "inplace",
      label: "enum KeyType",
      numberOfBytes: "1",
    },
    "t_mapping(t_bytes32,t_struct(Account)26_storage)": {
      encoding: "mapping",
      key: "t_bytes32",
      label: "mapping(bytes32 => struct Account)",
      numberOfBytes: "32",
      value: "t_struct(Account)26_storage",
    },
    "t_mapping(t_uint192,t_uint64)": {
      encoding: "mapping",
      key: "t_uint192",
      label: "mapping(uint192 => uint64)",
      numberOfBytes: "32",
      value: "t_uint64",
    },
    "t_mapping(t_uint256,t_bytes32)": {
      encoding: "mapping",
      key: "t_uint256",
      label: "mapping(uint256 => bytes32)",
      numberOfBytes: "32",
      value: "t_bytes32",
    },
    "t_struct(Account)26_storage": {
      encoding: "inplace",
      label: "struct Account",
      numberOfBytes: "96",
      members: [
        {
          astId: 19,
          contract: "src/Assessment.sol:Assessment",
          label: "nonces",
          offset: 0,
          slot: "0",
          type: "t_mapping(t_uint192,t_uint64)",
        },
        {
          astId: 23,
          contract: "src/Assessment.sol:Assessment",
          label: "credentials",
          offset: 0,
          slot: "1",
          type: "t_array(t_struct(Credential)15_storage)dyn_storage",
        },
        {
          astId: 25,
          contract: "src/Assessment.sol:Assessment",
          label: "activeCredentials",
          offset: 0,
          slot: "2",
          type: "t_uint64",
        },
      ],
    },
    "t_struct(Credential)15_storage": {
      encoding: "inplace",
      label: "struct Credential",
      numberOfBytes: "96",
      members: [
        {
          astId: 7,
          contract: "src/Assessment.sol:Assessment",
          label: "expiration",
          offset: 0,
          slot: "0",
          type: "t_uint40",
        },
        {
          astId: 10,
          contract: "src/Assessment.sol:Assessment",
          label: "keyType",
          offset: 5,
          slot: "0",
          type: "t_enum(KeyType)5",
        },
        {
          astId: 12,
          contract: "src/Assessment.sol:Assessment",
          label: "permissions",
          offset: 0,
          slot: "1",
          type: "t_uint256",
        },
        {
          astId: 14,
          contract: "src/Assessment.sol:Assessment",
          label: "publicKey",
          offset: 0,
          slot: "2",
          type: "t_bytes_storage",
        },
      ],
    },
    "t_struct(QueuedMutation)657_storage": {
      encoding: "inplace",
      label: "struct Typewriter.QueuedMutation",
      numberOfBytes: "96",
      members: [
        {
          astId: 650,
          contract: "src/Assessment.sol:Assessment",
          label: "mutation",
          offset: 0,
          slot: "0",
          type: "t_uint8",
        },
        {
          astId: 652,
          contract: "src/Assessment.sol:Assessment",
          label: "enqueuedTimestamp",
          offset: 1,
          slot: "0",
          type: "t_uint40",
        },
        {
          astId: 654,
          contract: "src/Assessment.sol:Assessment",
          label: "mutationData",
          offset: 0,
          slot: "1",
          type: "t_bytes_storage",
        },
        {
          astId: 656,
          contract: "src/Assessment.sol:Assessment",
          label: "authorizationData",
          offset: 0,
          slot: "2",
          type: "t_bytes_storage",
        },
      ],
    },
    "t_struct(State)1551_storage": {
      encoding: "inplace",
      label: "struct State",
      numberOfBytes: "64",
      members: [
        {
          astId: 1546,
          contract: "src/Assessment.sol:Assessment",
          label: "accumulator",
          offset: 0,
          slot: "0",
          type: "t_bytes32",
        },
        {
          astId: 1550,
          contract: "src/Assessment.sol:Assessment",
          label: "slots",
          offset: 0,
          slot: "1",
          type: "t_mapping(t_uint256,t_bytes32)",
        },
      ],
    },
    t_uint192: {
      encoding: "inplace",
      label: "uint192",
      numberOfBytes: "24",
    },
    t_uint256: {
      encoding: "inplace",
      label: "uint256",
      numberOfBytes: "32",
    },
    t_uint40: {
      encoding: "inplace",
      label: "uint40",
      numberOfBytes: "5",
    },
    t_uint64: {
      encoding: "inplace",
      label: "uint64",
      numberOfBytes: "8",
    },
    t_uint8: {
      encoding: "inplace",
      label: "uint8",
      numberOfBytes: "1",
    },
  },
} as const;

export const MUTATIONS = {
  A: {
    id: 0,
    params: [
      {
        name: "slot",
        type: "uint256",
      },
      {
        name: "value",
        type: "uint256",
      },
      {
        name: "shouldRevert",
        type: "bool",
      },
    ],
  },
  B: {
    id: 1,
    params: [
      {
        name: "slot",
        type: "uint256",
      },
      {
        name: "value",
        type: "uint256",
      },
      {
        name: "shouldRevert",
        type: "bool",
      },
    ],
  },
  C: {
    id: 2,
    params: [
      {
        name: "slot",
        type: "uint256",
      },
      {
        name: "data",
        type: "bytes",
      },
      {
        name: "memo",
        type: "string",
      },
      {
        name: "shouldRevert",
        type: "bool",
      },
    ],
  },
  D: {
    id: 3,
    params: [
      {
        name: "slot",
        type: "uint256",
      },
      {
        name: "to",
        type: "address",
      },
      {
        name: "delta",
        type: "int64",
      },
      {
        name: "tag",
        type: "bytes32",
      },
      {
        name: "small",
        type: "uint8",
      },
      {
        name: "window",
        type: "uint40",
      },
      {
        name: "shouldRevert",
        type: "bool",
      },
    ],
  },
  E: {
    id: 4,
    params: [
      {
        name: "slot",
        type: "uint256",
      },
      {
        name: "values",
        type: "uint256[]",
      },
      {
        name: "pair",
        type: "address[2]",
      },
      {
        name: "shouldRevert",
        type: "bool",
      },
    ],
  },
  CreateAccount: {
    id: 253,
    params: [
      {
        name: "keyType",
        type: "uint8",
      },
      {
        name: "publicKey",
        type: "bytes",
      },
    ],
  },
  AddCredential: {
    id: 254,
    params: [
      {
        name: "expiration",
        type: "uint40",
      },
      {
        name: "keyType",
        type: "uint8",
      },
      {
        name: "permissions",
        type: "uint256",
      },
      {
        name: "publicKey",
        type: "bytes",
      },
    ],
  },
  RemoveCredential: {
    id: 255,
    params: [
      {
        name: "credentialID",
        type: "uint64",
      },
    ],
  },
} as const;

export type AssessmentStorage = typeof STORAGE_LAYOUT;
export type AssessmentMutations = typeof MUTATIONS;

export const ASSESSMENT_PROJECT = `${import.meta.dir}/assessment`;

/** The Solidity entrypoint of the assessment app. */
export const ASSESSMENT_ENTRYPOINT =
  `${ASSESSMENT_PROJECT}/src/Assessment.sol` as TypewriterSolidityEntrypoint<{
    storageLayout: AssessmentStorage;
    mutations: AssessmentMutations;
  }>;
