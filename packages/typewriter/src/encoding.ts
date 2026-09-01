import { AbiParameters, type Hex } from "ox";
import { type Abi, encodeFunctionData } from "viem";
import type { Authorization, ExecutableMutation } from "./types";

export const AUTHORIZATION_ABI_PARAMS = [
  { name: "accountID", type: "bytes32" },
  { name: "credentialID", type: "uint64" },
  { name: "nonce", type: "uint256" },
  { name: "expiration", type: "uint256" },
  { name: "signature", type: "bytes" },
] as const satisfies readonly AbiParameters.Parameter[];

export const TYPEWRITER_ABI = [
  {
    type: "function",
    name: "execute",
    inputs: [
      {
        name: "batches",
        type: "tuple[]",
        components: [
          { name: "mutations", type: "uint8[]" },
          { name: "mutationData", type: "bytes[]" },
          { name: "authorizationData", type: "bytes[]" },
        ],
      },
      { name: "forceExecuteIndexes", type: "uint256[]" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "enqueue",
    inputs: [
      { name: "mutation", type: "uint8" },
      { name: "mutationData", type: "bytes" },
      { name: "authorizationData", type: "bytes" },
    ],
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "forceExecute",
    inputs: [{ name: "index", type: "uint256" }],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "executionIndex",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
  },
  {
    type: "event",
    name: "ForceInclusionQueued",
    inputs: [
      { name: "index", type: "uint256", indexed: false },
      { name: "mutation", type: "uint8", indexed: false },
      { name: "mutationData", type: "bytes", indexed: false },
      { name: "authorizationData", type: "bytes", indexed: false },
      { name: "enqueuedBlock", type: "uint256", indexed: false },
    ],
    anonymous: false,
  },
] as const satisfies Abi;

export type TypewriterAbi = typeof TYPEWRITER_ABI;

// Contract calldata and EIP-712 mutationData encode params as one top-level
// Solidity struct whose components are `mutation.params`.
function calldataStructParams(
  params: readonly AbiParameters.Parameter[],
): readonly AbiParameters.Parameter[] {
  return [{ type: "tuple", components: params as AbiParameters.Parameter[] }];
}

export function encodeMutationCalldata(mutation: ExecutableMutation): Hex.Hex {
  return AbiParameters.encode(calldataStructParams(mutation.config.params), [
    mutation.params,
  ]);
}

export function decodeMutationCalldata(
  mutationConfig: {
    params: readonly AbiParameters.Parameter[];
  },
  calldata: Hex.Hex,
): { params: unknown } {
  const [decodedParams] = AbiParameters.decode(
    calldataStructParams(mutationConfig.params),
    calldata,
  );
  return { params: decodedParams };
}

export function encodeAuthorizationCalldata(
  authorization: Authorization,
): Hex.Hex {
  return AbiParameters.encode(calldataStructParams(AUTHORIZATION_ABI_PARAMS), [
    authorization,
  ]);
}

export function decodeAuthorizationCalldata(calldata: Hex.Hex): Authorization {
  const [authorization] = AbiParameters.decode(
    calldataStructParams(AUTHORIZATION_ABI_PARAMS),
    calldata,
  );
  return authorization as Authorization;
}

// Encode `execute(Batch[], uint256[])` calldata from structured batch values
// and an optional list of force-inclusion queue indexes.
export function encodeExecuteCalldata(
  batches: readonly {
    mutations: readonly number[];
    mutationData: readonly Hex.Hex[];
    authorizationData: readonly Hex.Hex[];
  }[],
  forceExecuteIndexes: readonly bigint[],
): Hex.Hex {
  return encodeFunctionData({
    abi: TYPEWRITER_ABI,
    functionName: "execute",
    args: [batches, forceExecuteIndexes],
  });
}

export function encodeEnqueueCalldata(mutation: ExecutableMutation): Hex.Hex {
  return encodeFunctionData({
    abi: TYPEWRITER_ABI,
    functionName: "enqueue",
    args: [
      mutation.config.id,
      encodeMutationCalldata(mutation),
      encodeAuthorizationCalldata(mutation.authorization),
    ],
  });
}

// Build a structured Batch value from executable mutations.
export function encodeBatchArg(mutations: ExecutableMutation[]): {
  mutations: readonly number[];
  mutationData: readonly Hex.Hex[];
  authorizationData: readonly Hex.Hex[];
} {
  return {
    mutations: mutations.map((mutation) => mutation.config.id),
    mutationData: mutations.map((m) => encodeMutationCalldata(m)),
    authorizationData: mutations.map((mutation) =>
      encodeAuthorizationCalldata(mutation.authorization),
    ),
  };
}
