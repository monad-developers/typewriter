import { AbiParameters, type Hex } from "ox";
import { type Abi, encodeFunctionData } from "viem";
import type { FFCAMutationConfig } from "./config";
import type { MutationWithResolution } from "./types";

export const FFCA_ABI = [
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
          { name: "signatureData", type: "bytes[]" },
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
      { name: "signatureData", type: "bytes" },
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
      { name: "signatureData", type: "bytes", indexed: false },
      { name: "enqueuedBlock", type: "uint256", indexed: false },
    ],
    anonymous: false,
  },
] as const satisfies Abi;

export type FFCAAbi = typeof FFCA_ABI;

// FFCA mutation params are the flat semantic fields used for EIP-712. Contract
// calldata encodes those fields as one top-level Solidity struct. This assumes
// each mutation's calldata shape is exactly one struct whose components are
// `mutation.params`.
function calldataStructParams(
  params: readonly AbiParameters.Parameter[],
): readonly AbiParameters.Parameter[] {
  return [{ type: "tuple", components: params as AbiParameters.Parameter[] }];
}

export function encodeMutationCalldata(
  mutation: MutationWithResolution,
): Hex.Hex {
  const params = mutation.config.params;
  if (mutation.config.resolution !== undefined) {
    const resolutionParams = mutation.config.resolution;
    return AbiParameters.encode(
      [
        ...calldataStructParams(params),
        ...calldataStructParams(resolutionParams),
      ],
      [mutation.params, mutation.resolution],
    );
  }

  return AbiParameters.encode(calldataStructParams(params), [mutation.params]);
}

export function decodeMutationCalldata(
  mutationConfig: FFCAMutationConfig,
  calldata: Hex.Hex,
): { params: unknown; resolution?: unknown } {
  const params = mutationConfig.params;
  if (mutationConfig.resolution !== undefined) {
    const resolutionParams = mutationConfig.resolution;
    const [decodedParams, resolution] = AbiParameters.decode(
      [
        ...calldataStructParams(params),
        ...calldataStructParams(resolutionParams),
      ],
      calldata,
    );
    return { params: decodedParams, resolution };
  }

  const [decodedParams] = AbiParameters.decode(
    calldataStructParams(params),
    calldata,
  );
  return { params: decodedParams };
}

export function encodeSignatureCalldata(
  signatureParams: readonly AbiParameters.Parameter[],
  signature: unknown,
): Hex.Hex {
  return AbiParameters.encode(calldataStructParams(signatureParams), [
    signature,
  ]);
}

export function decodeSignatureCalldata(
  signatureParams: readonly AbiParameters.Parameter[],
  calldata: Hex.Hex,
): unknown {
  const [signature] = AbiParameters.decode(
    calldataStructParams(signatureParams),
    calldata,
  );
  return signature;
}

// Encode `execute(Batch[], uint256[])` calldata from structured batch values
// and an optional list of force-inclusion queue indexes.
export function encodeExecuteCalldata(
  batches: readonly {
    mutations: readonly number[];
    mutationData: readonly Hex.Hex[];
    signatureData: readonly Hex.Hex[];
  }[],
  forceExecuteIndexes: readonly bigint[],
): Hex.Hex {
  return encodeFunctionData({
    abi: FFCA_ABI,
    functionName: "execute",
    args: [batches, forceExecuteIndexes],
  });
}

export function encodeEnqueueCalldata(
  signatureParams: readonly AbiParameters.Parameter[],
  mutation: MutationWithResolution,
): Hex.Hex {
  const signatureValue = encodeSignatureCalldata(
    signatureParams,
    mutation.signature,
  );
  return encodeFunctionData({
    abi: FFCA_ABI,
    functionName: "enqueue",
    args: [
      mutation.config.tag,
      encodeMutationCalldata(mutation),
      signatureValue,
    ],
  });
}

// Build a structured Batch value from resolved mutations.
// Each signature is projected from a keyed record to a positional tuple
// matching the ABI declaration order.
export function encodeBatchArg(
  signatureParams: readonly AbiParameters.Parameter[],
  mutations: MutationWithResolution[],
): {
  mutations: readonly number[];
  mutationData: readonly Hex.Hex[];
  signatureData: readonly Hex.Hex[];
} {
  return {
    mutations: mutations.map((m) => m.config.tag),
    mutationData: mutations.map((m) => encodeMutationCalldata(m)),
    signatureData: mutations.map((m) =>
      encodeSignatureCalldata(signatureParams, m.signature),
    ),
  };
}
