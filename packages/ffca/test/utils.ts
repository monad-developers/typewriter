import { parseAbiParameters } from "abitype";
import {
  type Abi,
  AbiParameters,
  Hash,
  Hex as OxHex,
  P256,
  Secp256k1,
  type TypedData,
} from "ox";
import { Authentication } from "ox/webauthn";
import type { StorageLayout, StorageProxy } from "storage-layout";
import type { Address, Hex } from "viem";
import { anvil } from "viem/chains";
import type { FFCAMutationConfig } from "../src/config";
import { hashMutationEip712 } from "../src/eip712";
import {
  SCHEDULER_ACCOUNT,
  TEST_PUBLIC_CLIENT,
  TEST_WALLET_CLIENT,
} from "./setup";

// Counter's EIP-712 domain. Matches the constructor args used in
// deployCounter() so client-side digests align with the on-chain
// domainSeparator.
export const COUNTER_DOMAIN = { name: "Counter", version: "1" } as const;

export const EMPTY_STORAGE_LAYOUT = {
  storage: [],
  types: {},
} as const satisfies StorageLayout;

// Minimal ABI for tests that createFFCA without a real contract. Contains the
// execute function and ForceInclusionQueued event so signatureParamsFromAbi
// and the watch layer have the shapes they expect.
export const STUB_FFCA_ABI = [
  {
    type: "function",
    name: "execute",
    inputs: [
      {
        name: "bundles",
        type: "tuple[]",
        internalType: "struct Bundle[]",
        components: [
          { name: "mutations", type: "uint8[]", internalType: "uint8[]" },
          { name: "mutationData", type: "bytes[]", internalType: "bytes[]" },
          {
            name: "signatures",
            type: "tuple[]",
            internalType: "struct Signature[]",
            components: [
              { name: "keyType", type: "uint8", internalType: "uint8" },
              { name: "rawSignature", type: "bytes", internalType: "bytes" },
            ],
          },
        ],
      },
      {
        name: "forceExecuteIndexes",
        type: "uint256[]",
        internalType: "uint256[]",
      },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "event",
    name: "ForceInclusionQueued",
    inputs: [
      {
        name: "index",
        type: "uint256",
        indexed: false,
        internalType: "uint256",
      },
      {
        name: "mutation",
        type: "uint8",
        indexed: false,
        internalType: "uint8",
      },
      {
        name: "mutationData",
        type: "bytes",
        indexed: false,
        internalType: "bytes",
      },
      {
        name: "sig",
        type: "tuple",
        indexed: false,
        internalType: "struct Signature",
        components: [
          { name: "keyType", type: "uint8", internalType: "uint8" },
          { name: "rawSignature", type: "bytes", internalType: "bytes" },
        ],
      },
      {
        name: "enqueuedBlock",
        type: "uint256",
        indexed: false,
        internalType: "uint256",
      },
    ],
    anonymous: false,
  },
] as const satisfies Abi.Abi;

// Copied from forge's generated `storageLayout` and flattened to the app-owned
// Counter.State shape used by the runtime tests.
export const COUNTER_STORAGE_LAYOUT = {
  storage: [
    {
      astId: 827,
      contract: "src/Counter.sol:Counter",
      label: "total",
      offset: 0,
      slot: "0",
      type: "t_uint256",
    },
    {
      astId: 829,
      contract: "src/Counter.sol:Counter",
      label: "nonce",
      offset: 0,
      slot: "1",
      type: "t_uint256",
    },
  ],
  types: {
    "t_array(t_struct(QueuedMutation)845_storage)dyn_storage": {
      encoding: "dynamic_array",
      label: "struct QueuedMutation[]",
      numberOfBytes: "32",
      base: "t_struct(QueuedMutation)845_storage",
    },
    t_bytes_storage: { encoding: "bytes", label: "bytes", numberOfBytes: "32" },
    "t_struct(QueuedMutation)845_storage": {
      encoding: "inplace",
      label: "struct QueuedMutation",
      numberOfBytes: "160",
      members: [
        {
          astId: 837,
          contract: "src/Counter.sol:Counter",
          label: "mutation",
          offset: 0,
          slot: "0",
          type: "t_uint8",
        },
        {
          astId: 839,
          contract: "src/Counter.sol:Counter",
          label: "mutationData",
          offset: 0,
          slot: "1",
          type: "t_bytes_storage",
        },
        {
          astId: 842,
          contract: "src/Counter.sol:Counter",
          label: "sig",
          offset: 0,
          slot: "2",
          type: "t_struct(Signature)814_storage",
        },
        {
          astId: 844,
          contract: "src/Counter.sol:Counter",
          label: "enqueuedBlock",
          offset: 0,
          slot: "4",
          type: "t_uint256",
        },
      ],
    },
    "t_struct(Signature)814_storage": {
      encoding: "inplace",
      label: "struct Signature",
      numberOfBytes: "64",
      members: [
        {
          astId: 811,
          contract: "src/Counter.sol:Counter",
          label: "keyType",
          offset: 0,
          slot: "0",
          type: "t_uint8",
        },
        {
          astId: 813,
          contract: "src/Counter.sol:Counter",
          label: "rawSignature",
          offset: 0,
          slot: "1",
          type: "t_bytes_storage",
        },
      ],
    },
    "t_struct(State)830_storage": {
      encoding: "inplace",
      label: "struct State",
      numberOfBytes: "64",
      members: [
        {
          astId: 827,
          contract: "src/Counter.sol:Counter",
          label: "total",
          offset: 0,
          slot: "0",
          type: "t_uint256",
        },
        {
          astId: 829,
          contract: "src/Counter.sol:Counter",
          label: "nonce",
          offset: 0,
          slot: "1",
          type: "t_uint256",
        },
      ],
    },
    t_uint256: { encoding: "inplace", label: "uint256", numberOfBytes: "32" },
    t_uint8: { encoding: "inplace", label: "uint8", numberOfBytes: "1" },
  },
} as const satisfies StorageLayout;

export const COUNTER_ABI = [
  {
    type: "constructor",
    inputs: [{ name: "_signer", type: "address", internalType: "address" }],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "domainSeparator",
    inputs: [],
    outputs: [{ name: "", type: "bytes32", internalType: "bytes32" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "enqueue",
    inputs: [
      { name: "mutation", type: "uint8", internalType: "uint8" },
      { name: "mutationData", type: "bytes", internalType: "bytes" },
      {
        name: "sig",
        type: "tuple",
        internalType: "struct Signature",
        components: [
          { name: "keyType", type: "uint8", internalType: "uint8" },
          { name: "rawSignature", type: "bytes", internalType: "bytes" },
        ],
      },
    ],
    outputs: [{ name: "", type: "uint256", internalType: "uint256" }],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "execute",
    inputs: [
      {
        name: "bundles",
        type: "tuple[]",
        internalType: "struct Bundle[]",
        components: [
          { name: "mutations", type: "uint8[]", internalType: "uint8[]" },
          {
            name: "mutationData",
            type: "bytes[]",
            internalType: "bytes[]",
          },
          {
            name: "signatures",
            type: "tuple[]",
            internalType: "struct Signature[]",
            components: [
              { name: "keyType", type: "uint8", internalType: "uint8" },
              {
                name: "rawSignature",
                type: "bytes",
                internalType: "bytes",
              },
            ],
          },
        ],
      },
      {
        name: "forceExecuteIndexes",
        type: "uint256[]",
        internalType: "uint256[]",
      },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "forceExecute",
    inputs: [{ name: "index", type: "uint256", internalType: "uint256" }],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "scheduler",
    inputs: [],
    outputs: [{ name: "", type: "address", internalType: "address" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "signer",
    inputs: [],
    outputs: [{ name: "", type: "address", internalType: "address" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "state",
    inputs: [],
    outputs: [
      { name: "total", type: "uint256", internalType: "uint256" },
      { name: "nonce", type: "uint256", internalType: "uint256" },
    ],
    stateMutability: "view",
  },
  {
    type: "event",
    name: "ForceInclusionQueued",
    inputs: [
      {
        name: "index",
        type: "uint256",
        indexed: false,
        internalType: "uint256",
      },
      {
        name: "mutation",
        type: "uint8",
        indexed: false,
        internalType: "uint8",
      },
      {
        name: "mutationData",
        type: "bytes",
        indexed: false,
        internalType: "bytes",
      },
      {
        name: "sig",
        type: "tuple",
        indexed: false,
        internalType: "struct Signature",
        components: [
          { name: "keyType", type: "uint8", internalType: "uint8" },
          { name: "rawSignature", type: "bytes", internalType: "bytes" },
        ],
      },
      {
        name: "enqueuedBlock",
        type: "uint256",
        indexed: false,
        internalType: "uint256",
      },
    ],
    anonymous: false,
  },
  { type: "error", name: "AlreadyExecuted", inputs: [] },
  { type: "error", name: "InvalidNonce", inputs: [] },
  {
    type: "error",
    name: "InvalidSignature",
    inputs: [{ name: "keyType", type: "uint8", internalType: "enum KeyType" }],
  },
  { type: "error", name: "TooEarly", inputs: [] },
  { type: "error", name: "Unauthorized", inputs: [] },
  { type: "error", name: "UnknownTag", inputs: [] },
] as const satisfies Abi.Abi;

export const HARNESS_DOMAIN = { name: "Harness", version: "1" } as const;

// Copied from forge's generated `storageLayout` and flattened to the app-owned
// Harness.State shape used by the runtime tests.
export const HARNESS_STORAGE_LAYOUT = {
  storage: [
    {
      astId: 1412,
      contract: "src/Harness.sol:Harness",
      label: "accounts",
      offset: 0,
      slot: "0",
      type: "t_mapping(t_bytes32,t_struct(Account)1407_storage)",
    },
    {
      astId: 1416,
      contract: "src/Harness.sol:Harness",
      label: "balances",
      offset: 0,
      slot: "1",
      type: "t_mapping(t_bytes32,t_uint256)",
    },
  ],
  types: {
    "t_array(t_struct(Key)1398_storage)dyn_storage": {
      encoding: "dynamic_array",
      label: "struct Key[]",
      numberOfBytes: "32",
      base: "t_struct(Key)1398_storage",
    },
    "t_array(t_struct(QueuedMutation)1393_storage)dyn_storage": {
      encoding: "dynamic_array",
      label: "struct QueuedMutation[]",
      numberOfBytes: "32",
      base: "t_struct(QueuedMutation)1393_storage",
    },
    t_bytes32: { encoding: "inplace", label: "bytes32", numberOfBytes: "32" },
    t_bytes_storage: { encoding: "bytes", label: "bytes", numberOfBytes: "32" },
    "t_mapping(t_bytes32,t_struct(Account)1407_storage)": {
      encoding: "mapping",
      key: "t_bytes32",
      label: "mapping(bytes32 => struct Account)",
      numberOfBytes: "32",
      value: "t_struct(Account)1407_storage",
    },
    "t_mapping(t_bytes32,t_uint256)": {
      encoding: "mapping",
      key: "t_bytes32",
      label: "mapping(bytes32 => uint256)",
      numberOfBytes: "32",
      value: "t_uint256",
    },
    "t_mapping(t_uint192,t_uint64)": {
      encoding: "mapping",
      key: "t_uint192",
      label: "mapping(uint192 => uint64)",
      numberOfBytes: "32",
      value: "t_uint64",
    },
    "t_struct(Account)1407_storage": {
      encoding: "inplace",
      label: "struct Account",
      numberOfBytes: "64",
      members: [
        {
          astId: 1402,
          contract: "src/Harness.sol:Harness",
          label: "keys",
          offset: 0,
          slot: "0",
          type: "t_array(t_struct(Key)1398_storage)dyn_storage",
        },
        {
          astId: 1406,
          contract: "src/Harness.sol:Harness",
          label: "nonces",
          offset: 0,
          slot: "1",
          type: "t_mapping(t_uint192,t_uint64)",
        },
      ],
    },
    "t_struct(Key)1398_storage": {
      encoding: "inplace",
      label: "struct Key",
      numberOfBytes: "64",
      members: [
        {
          astId: 1395,
          contract: "src/Harness.sol:Harness",
          label: "keyType",
          offset: 0,
          slot: "0",
          type: "t_uint8",
        },
        {
          astId: 1397,
          contract: "src/Harness.sol:Harness",
          label: "publicKey",
          offset: 0,
          slot: "1",
          type: "t_bytes_storage",
        },
      ],
    },
    "t_struct(QueuedMutation)1393_storage": {
      encoding: "inplace",
      label: "struct QueuedMutation",
      numberOfBytes: "192",
      members: [
        {
          astId: 1385,
          contract: "src/Harness.sol:Harness",
          label: "mutation",
          offset: 0,
          slot: "0",
          type: "t_uint8",
        },
        {
          astId: 1387,
          contract: "src/Harness.sol:Harness",
          label: "mutationData",
          offset: 0,
          slot: "1",
          type: "t_bytes_storage",
        },
        {
          astId: 1390,
          contract: "src/Harness.sol:Harness",
          label: "sig",
          offset: 0,
          slot: "2",
          type: "t_struct(Signature)1372_storage",
        },
        {
          astId: 1392,
          contract: "src/Harness.sol:Harness",
          label: "enqueuedBlock",
          offset: 0,
          slot: "5",
          type: "t_uint256",
        },
      ],
    },
    "t_struct(Signature)1372_storage": {
      encoding: "inplace",
      label: "struct Signature",
      numberOfBytes: "96",
      members: [
        {
          astId: 1365,
          contract: "src/Harness.sol:Harness",
          label: "account",
          offset: 0,
          slot: "0",
          type: "t_bytes32",
        },
        {
          astId: 1367,
          contract: "src/Harness.sol:Harness",
          label: "keyId",
          offset: 0,
          slot: "1",
          type: "t_uint64",
        },
        {
          astId: 1369,
          contract: "src/Harness.sol:Harness",
          label: "keyType",
          offset: 8,
          slot: "1",
          type: "t_uint8",
        },
        {
          astId: 1371,
          contract: "src/Harness.sol:Harness",
          label: "rawSignature",
          offset: 0,
          slot: "2",
          type: "t_bytes_storage",
        },
      ],
    },
    "t_struct(State)1417_storage": {
      encoding: "inplace",
      label: "struct State",
      numberOfBytes: "64",
      members: [
        {
          astId: 1412,
          contract: "src/Harness.sol:Harness",
          label: "accounts",
          offset: 0,
          slot: "0",
          type: "t_mapping(t_bytes32,t_struct(Account)1407_storage)",
        },
        {
          astId: 1416,
          contract: "src/Harness.sol:Harness",
          label: "balances",
          offset: 0,
          slot: "1",
          type: "t_mapping(t_bytes32,t_uint256)",
        },
      ],
    },
    t_uint192: { encoding: "inplace", label: "uint192", numberOfBytes: "24" },
    t_uint256: { encoding: "inplace", label: "uint256", numberOfBytes: "32" },
    t_uint64: { encoding: "inplace", label: "uint64", numberOfBytes: "8" },
    t_uint8: { encoding: "inplace", label: "uint8", numberOfBytes: "1" },
  },
} as const satisfies StorageLayout;

export const HARNESS_ABI = [
  { type: "constructor", inputs: [], stateMutability: "nonpayable" },
  {
    type: "function",
    name: "balances",
    inputs: [{ name: "account", type: "bytes32", internalType: "bytes32" }],
    outputs: [{ name: "", type: "uint256", internalType: "uint256" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "domainSeparator",
    inputs: [],
    outputs: [{ name: "", type: "bytes32", internalType: "bytes32" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "enqueue",
    inputs: [
      { name: "mutation", type: "uint8", internalType: "uint8" },
      { name: "mutationData", type: "bytes", internalType: "bytes" },
      {
        name: "sig",
        type: "tuple",
        internalType: "struct Signature",
        components: [
          { name: "account", type: "bytes32", internalType: "bytes32" },
          { name: "keyId", type: "uint64", internalType: "uint64" },
          { name: "keyType", type: "uint8", internalType: "uint8" },
          { name: "rawSignature", type: "bytes", internalType: "bytes" },
        ],
      },
    ],
    outputs: [{ name: "", type: "uint256", internalType: "uint256" }],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "execute",
    inputs: [
      {
        name: "bundles",
        type: "tuple[]",
        internalType: "struct Bundle[]",
        components: [
          { name: "mutations", type: "uint8[]", internalType: "uint8[]" },
          {
            name: "mutationData",
            type: "bytes[]",
            internalType: "bytes[]",
          },
          {
            name: "signatures",
            type: "tuple[]",
            internalType: "struct Signature[]",
            components: [
              { name: "account", type: "bytes32", internalType: "bytes32" },
              { name: "keyId", type: "uint64", internalType: "uint64" },
              { name: "keyType", type: "uint8", internalType: "uint8" },
              {
                name: "rawSignature",
                type: "bytes",
                internalType: "bytes",
              },
            ],
          },
        ],
      },
      {
        name: "forceExecuteIndexes",
        type: "uint256[]",
        internalType: "uint256[]",
      },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "forceExecute",
    inputs: [{ name: "index", type: "uint256", internalType: "uint256" }],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "keyOf",
    inputs: [
      { name: "account", type: "bytes32", internalType: "bytes32" },
      { name: "keyId", type: "uint64", internalType: "uint64" },
    ],
    outputs: [
      { name: "", type: "uint8", internalType: "uint8" },
      { name: "", type: "bytes", internalType: "bytes" },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "nonceOf",
    inputs: [
      { name: "account", type: "bytes32", internalType: "bytes32" },
      { name: "nonceKey", type: "uint192", internalType: "uint192" },
    ],
    outputs: [{ name: "", type: "uint64", internalType: "uint64" }],
    stateMutability: "view",
  },
  {
    type: "event",
    name: "ForceInclusionQueued",
    inputs: [
      {
        name: "index",
        type: "uint256",
        indexed: false,
        internalType: "uint256",
      },
      {
        name: "mutation",
        type: "uint8",
        indexed: false,
        internalType: "uint8",
      },
      {
        name: "mutationData",
        type: "bytes",
        indexed: false,
        internalType: "bytes",
      },
      {
        name: "sig",
        type: "tuple",
        indexed: false,
        internalType: "struct Signature",
        components: [
          { name: "account", type: "bytes32", internalType: "bytes32" },
          { name: "keyId", type: "uint64", internalType: "uint64" },
          { name: "keyType", type: "uint8", internalType: "uint8" },
          { name: "rawSignature", type: "bytes", internalType: "bytes" },
        ],
      },
      {
        name: "enqueuedBlock",
        type: "uint256",
        indexed: false,
        internalType: "uint256",
      },
    ],
    anonymous: false,
  },
  { type: "error", name: "AlreadyExecuted", inputs: [] },
  { type: "error", name: "AlreadyInitialized", inputs: [] },
  { type: "error", name: "InvalidAccount", inputs: [] },
  { type: "error", name: "InvalidNonce", inputs: [] },
  {
    type: "error",
    name: "InvalidSignature",
    inputs: [{ name: "keyType", type: "uint8", internalType: "enum KeyType" }],
  },
  { type: "error", name: "TooEarly", inputs: [] },
  { type: "error", name: "UnknownTag", inputs: [] },
] as const satisfies Abi.Abi;

// Deploy a forge-built contract by name. Reads the artifact from the
// contracts workspace, broadcasts via the test wallet, waits for the
// receipt, returns the deployed address. ABIs live alongside the storage
// layouts in this file (`COUNTER_ABI`, `HARNESS_ABI`) so tests can reference
// them as typed constants instead of pulling untyped `any` out of the
// artifact JSON.
async function deployContract(
  name: string,
  args?: readonly unknown[],
): Promise<Address> {
  const artifact = await Bun.file(
    `${import.meta.dir}/contracts/out/${name}.sol/${name}.json`,
  ).json();
  const hash = await TEST_WALLET_CLIENT.deployContract({
    abi: artifact.abi,
    bytecode: artifact.bytecode.object as Hex,
    account: SCHEDULER_ACCOUNT,
    chain: anvil,
    // biome-ignore lint/suspicious/noExplicitAny: viem deployContract args type
    args: args as any,
  });
  const receipt = await TEST_PUBLIC_CLIENT.waitForTransactionReceipt({ hash });
  if (
    receipt.contractAddress === null ||
    receipt.contractAddress === undefined
  ) {
    throw new Error(`${name} deploy missing address`);
  }
  return receipt.contractAddress;
}

// Deploy Counter wired to a single secp256k1 signer. The contract hardcodes
// its EIP-712 domain (name="Counter", version="1"); only the signer is a
// constructor arg.
export async function deployCounter(signerAddress: Address): Promise<Address> {
  return deployContract("Counter", [signerAddress]);
}

export const deployHarness = (): Promise<Address> => deployContract("Harness");

// Mutation definitions for the Counter test fixture. The contract/revm owns
// acceptance and state transitions; this config only describes encoding.
export const COUNTER_MUTATIONS: { add: FFCAMutationConfig } = {
  add: {
    tag: 0,
    params: parseAbiParameters("uint256 amount, uint256 nonce"),
  },
};

// Sign Counter's `add` mutation. Counter is a single-signer secp256k1
// fixture, so this always returns a secp256k1 rawSignature.
export function signCounter(params: {
  privateKey: Hex;
  amount: bigint;
  nonce: bigint;
  address: Address;
  chainId: number;
}): { keyType: 2; rawSignature: Hex } {
  const domain: TypedData.Domain = {
    name: COUNTER_DOMAIN.name,
    version: COUNTER_DOMAIN.version,
    chainId: params.chainId,
    verifyingContract: params.address,
  };
  const digest = hashMutationEip712(
    COUNTER_MUTATIONS.add,
    "add",
    { amount: params.amount, nonce: params.nonce },
    domain,
  );
  return {
    keyType: 2,
    rawSignature: signSecp256k1Raw(digest, params.privateKey),
  };
}

// Mutation definitions for the Harness test fixture. Tags match the contract:
//   initialize (0): bootstraps an account with a root key. Account id is
//                    derived as keccak256(rootPublicKey); no signature.
//   authorize  (1): adds a key to an existing account. Signed by an
//                    existing key.
//   credit     (2): adds amount to balance. Signed.
//   debit      (3): resolve computes newBalance from revm-backed state; the
//                    contract rejects the bundle if the resolution doesn't
//                    match its own pre-state. Signed.
//   assert     (4): read-only check; the contract reverts if balance !=
//                    expected. Signed.
type DebitArgs = {
  account: Hex;
  keyId: bigint;
  amount: bigint;
  nonce: bigint;
};
export const HARNESS_MUTATIONS: {
  initialize: FFCAMutationConfig;
  authorize: FFCAMutationConfig;
  credit: FFCAMutationConfig;
  debit: FFCAMutationConfig;
  assert: FFCAMutationConfig;
} = {
  initialize: {
    tag: 0,
    params: parseAbiParameters("uint8 rootKeyType, bytes rootPublicKey"),
  },
  authorize: {
    tag: 1,
    params: parseAbiParameters(
      "bytes32 account, uint64 keyId, uint8 keyType, bytes publicKey, uint256 nonce",
    ),
  },
  credit: {
    tag: 2,
    params: parseAbiParameters(
      "bytes32 account, uint64 keyId, uint256 amount, uint256 nonce",
    ),
  },
  debit: {
    tag: 3,
    params: parseAbiParameters(
      "bytes32 account, uint64 keyId, uint256 amount, uint256 nonce",
    ),
    resolution: parseAbiParameters("uint256 newBalance"),
    resolve: async ({
      state,
      args,
    }: {
      state: unknown;
      args: unknown;
      signature: unknown;
    }) => {
      const harnessStorage = state as StorageProxy<
        typeof HARNESS_STORAGE_LAYOUT,
        true
      >;
      const debit = args as DebitArgs;
      const balance = await harnessStorage.balances[debit.account];
      if (balance === undefined) {
        return { newBalance: -debit.amount };
      }
      return {
        newBalance: balance - debit.amount,
      };
    },
  },
  assert: {
    tag: 4,
    params: parseAbiParameters(
      "bytes32 account, uint64 keyId, uint256 expected, uint256 nonce",
    ),
  },
};

// Derive the bytes32 account id from a public key (matches Harness.sol's
// `keccak256(rootPublicKey)` bootstrap rule).
export function harnessAccountId(publicKey: Hex): Hex {
  return Hash.keccak256(publicKey) as Hex;
}

// secp256k1 public key for an EOA, in the abi.encode(address) form
// Account.sol's verifySecp256k1 expects.
export function secp256k1PublicKey(address: Address): Hex {
  return AbiParameters.encode(parseAbiParameters("address"), [address]);
}

// P-256 public key for a private key, in the abi.encode(uint256 x, uint256 y)
// form Account.sol's verifyP256 / decodeP256PublicKey accepts.
export function p256PublicKey(privateKey: Hex): Hex {
  const pk = P256.getPublicKey({ privateKey });
  return AbiParameters.encode(parseAbiParameters("uint256 x, uint256 y"), [
    pk.x,
    pk.y,
  ]);
}

// Sign a digest with a P-256 private key. Returns rawSignature in the
// abi.encode(uint256 r, uint256 s) form. The contract sha256s the digest
// before passing to the precompile, so we sign with hash: true to match.
export function signP256Raw(digest: Hex, privateKey: Hex): Hex {
  const sig = P256.sign({ payload: digest, privateKey, hash: true });
  return AbiParameters.encode(parseAbiParameters("uint256 r, uint256 s"), [
    sig.r,
    sig.s,
  ]);
}

// Sign a digest as a WebAuthn-P256 challenge. Returns rawSignature in the
// abi.encode(bytes authData, bytes clientDataJSON, uint256 challengeOffset,
// uint256 r, uint256 s) form Account.sol's verifyWebAuthnP256 expects.
//
// rpId/origin are fixed to empty strings — Account.sol doesn't inspect
// either, so their values don't affect on-chain verification. Real apps
// that care about origin enforcement would do that check off-chain
// (browser refuses to sign for the wrong RP ID anyway).
export function signWebAuthnP256Raw(digest: Hex, privateKey: Hex): Hex {
  const { metadata, payload } = Authentication.getSignPayload({
    challenge: digest,
    rpId: "",
    origin: "",
    userVerification: "required",
  });
  const sig = P256.sign({ payload, privateKey, hash: true });
  // Account.sol's verifyChallenge expects the byte offset at which the
  // base64url-encoded challenge VALUE starts inside clientDataJSON. ox's
  // `challengeIndex` points at the JSON key (`"challenge":"`), so add 13
  // to land on the first byte of the value.
  const challengeOffset =
    metadata.clientDataJSON.indexOf('"challenge":"') + '"challenge":"'.length;
  return AbiParameters.encode(
    parseAbiParameters(
      "bytes authData, bytes clientDataJSON, uint256 challengeOffset, uint256 r, uint256 s",
    ),
    [
      metadata.authenticatorData,
      OxHex.fromString(metadata.clientDataJSON),
      BigInt(challengeOffset),
      sig.r,
      sig.s,
    ],
  );
}

// Sign one of Harness's signed mutation types. Returns the structured
// signature ffca encodes into bundle.signatures[i].
export function signHarness(params: {
  keyType: number;
  privateKey: Hex;
  mutation: "authorize" | "credit" | "debit" | "assert";
  args: Record<string, unknown>;
  address: Address;
  chainId: number;
}): Hex {
  const domain: TypedData.Domain = {
    name: HARNESS_DOMAIN.name,
    version: HARNESS_DOMAIN.version,
    chainId: params.chainId,
    verifyingContract: params.address,
  };
  const digest = hashMutationEip712(
    HARNESS_MUTATIONS[params.mutation],
    params.mutation,
    params.args,
    domain,
  );
  if (params.keyType === 0) return signP256Raw(digest, params.privateKey);
  if (params.keyType === 1)
    return signWebAuthnP256Raw(digest, params.privateKey);
  if (params.keyType === 2) return signSecp256k1Raw(digest, params.privateKey);
  throw new Error(`signHarness: unknown keyType ${params.keyType}`);
}

function signSecp256k1Raw(digest: Hex, privateKey: Hex): Hex {
  const signature = Secp256k1.sign({ payload: digest, privateKey });
  return AbiParameters.encode(
    parseAbiParameters("uint8 v, bytes32 r, bytes32 s"),
    [
      signature.yParity + 27,
      OxHex.fromNumber(signature.r, { size: 32 }),
      OxHex.fromNumber(signature.s, { size: 32 }),
    ],
  );
}

// Bootstrap an account by submitting an `initialize` mutation. Returns the
// derived account id so callers can reference it. The signature is unused
// by the contract (initialize is bootstrap) but ffca's wire format still
// requires a structured value, so we pass a stub.
export async function setupHarnessAccount(
  // biome-ignore lint/suspicious/noExplicitAny: structural typing for the ffca instance
  ffca: { execute: (m: any) => Promise<any> },
  params: { rootKeyType: number; rootPublicKey: Hex },
): Promise<Hex> {
  const account = harnessAccountId(params.rootPublicKey);
  await ffca.execute({
    name: "initialize",
    args: {
      rootKeyType: params.rootKeyType,
      rootPublicKey: params.rootPublicKey,
    },
    signature: {
      account,
      keyId: 0n,
      keyType: params.rootKeyType,
      rawSignature: "0x",
    },
  });
  return account;
}
