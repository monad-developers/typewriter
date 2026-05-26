import { type Abi, AbiParameters, type Hex } from "ox";
import { decodeEventLog, encodeFunctionData } from "viem";
import type { FFCAMutationConfig } from "./config";
import type { MutationWithResolution } from "./types";

export type FFCAAbi = [
  {
    type: "function";
    name: "execute";
    inputs: [
      {
        name: "batches";
        type: "tuple[]";
        components: [
          { name: "mutations"; type: "uint8[]" },
          { name: "mutationData"; type: "bytes[]" },
          {
            name: "signatures";
            type: "tuple[]";
            components: readonly AbiParameters.Parameter[];
          },
        ];
      },
      { name: "forceExecuteIndexes"; type: "uint256[]" },
    ];
    outputs: [];
    stateMutability: "nonpayable";
  },
  {
    type: "function";
    name: "enqueue";
    inputs: [
      { name: "mutation"; type: "uint8" },
      { name: "mutationData"; type: "bytes" },
      {
        name: "sig";
        type: "tuple";
        components: readonly AbiParameters.Parameter[];
      },
    ];
    outputs: [];
    stateMutability: "nonpayable";
  },
  {
    type: "function";
    name: "forceExecute";
    inputs: [{ name: "index"; type: "uint256" }];
    outputs: [];
    stateMutability: "nonpayable";
  },
  {
    type: "event";
    name: "ForceInclusionQueued";
    inputs: [
      { name: "index"; type: "uint256"; indexed: false },
      { name: "mutation"; type: "uint8"; indexed: false },
      { name: "mutationData"; type: "bytes"; indexed: false },
      {
        name: "sig";
        type: "tuple";
        components: readonly AbiParameters.Parameter[];
        indexed: false;
      },
      { name: "enqueuedBlock"; type: "uint256"; indexed: false },
    ];
    anonymous: false;
  },
];

// Records keyed by param name are ffca's canonical shape for both args and
// signatures (the form clients post and the form `resolve` consumes).
// ABI-encode wants a positional tuple in declaration order; project to it.
function abiTupleFromRecord(
  params: readonly AbiParameters.Parameter[],
  record: unknown,
): readonly unknown[] {
  const r = record as Record<string, unknown>;
  return params.map((p) => r[p.name ?? ""]);
}

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
  if ("resolution" in mutation.config) {
    const resolutionParams = mutation.config.resolution;
    return AbiParameters.encode(
      [
        ...calldataStructParams(params),
        ...calldataStructParams(resolutionParams),
      ],
      [mutation.args, mutation.resolution],
    );
  }

  return AbiParameters.encode(calldataStructParams(params), [mutation.args]);
}

export function decodeMutationCalldata(
  mutationConfig: FFCAMutationConfig,
  calldata: Hex.Hex,
): { args: unknown; resolution?: unknown } {
  const params = mutationConfig.params;
  if ("resolution" in mutationConfig) {
    const resolutionParams = mutationConfig.resolution;
    const [args, resolution] = AbiParameters.decode(
      [
        ...calldataStructParams(params),
        ...calldataStructParams(resolutionParams),
      ],
      calldata,
    );
    return { args, resolution };
  }

  const [args] = AbiParameters.decode(calldataStructParams(params), calldata);
  return { args };
}

// Extract the signature tuple components from the user's ABI.
// FFCA prescribes that `execute` takes `(Batch[], uint256[])` where
//   Batch = { uint8[] mutations, bytes[] mutationData, Signature[] signatures }
// This walks the ABI to find `execute` -> `batches` -> `signatures`.
export function getSignatureAbiParameters(
  abi: Abi.Abi,
): readonly AbiParameters.Parameter[] {
  const execute = abi.find(
    (item) => item.type === "function" && item.name === "execute",
  ) as Extract<Abi.Abi[number], { type: "function" }> | undefined;
  if (execute === undefined) {
    throw new Error("ABI missing execute function");
  }

  const batches = execute.inputs.find(
    (input) =>
      input.name === "batches" &&
      input.type === "tuple[]" &&
      "components" in input &&
      Array.isArray(input.components),
  ) as
    | (AbiParameters.Parameter & {
        type: "tuple[]";
        components: readonly AbiParameters.Parameter[];
      })
    | undefined;
  if (batches === undefined) {
    throw new Error("execute function missing batches: tuple[] parameter");
  }

  const signatures = batches.components.find(
    (c) =>
      c.name === "signatures" &&
      c.type === "tuple[]" &&
      "components" in c &&
      Array.isArray(c.components),
  ) as
    | (AbiParameters.Parameter & {
        type: "tuple[]";
        components: readonly AbiParameters.Parameter[];
      })
    | undefined;
  if (signatures === undefined) {
    throw new Error("Batch missing signatures: tuple[] component");
  }

  return signatures.components;
}

export function encodeSignatureCalldata(
  sigParams: readonly AbiParameters.Parameter[],
  signature: unknown,
): Hex.Hex {
  return AbiParameters.encode(
    sigParams,
    abiTupleFromRecord(sigParams, signature),
  );
}

export function decodeSignatureCalldata(
  sigParams: readonly AbiParameters.Parameter[],
  calldata: Hex.Hex,
): unknown {
  return AbiParameters.decode(sigParams, calldata);
}

// Encode `execute(Batch[], uint256[])` calldata from structured batch values
// and an optional list of force-inclusion queue indexes.
export function encodeExecuteCalldata(
  abi: Abi.Abi,
  batches: readonly {
    mutations: number[];
    mutationData: Hex.Hex[];
    signatures: readonly unknown[][];
  }[],
  forceExecuteIndexes: readonly bigint[],
): Hex.Hex {
  return encodeFunctionData({
    abi,
    functionName: "execute",
    args: [batches, forceExecuteIndexes],
  });
}

export function encodeEnqueueCalldata(
  abi: Abi.Abi,
  mutation: MutationWithResolution,
): Hex.Hex {
  const sigParams = getSignatureAbiParameters(abi);
  return encodeFunctionData({
    abi,
    functionName: "enqueue",
    args: [
      mutation.config.tag,
      encodeMutationCalldata(mutation),
      abiTupleFromRecord(sigParams, mutation.signature),
    ],
  });
}

// Decode a `ForceInclusionQueued` event log into its named arguments.
export function decodeForceInclusionLog(
  abi: Abi.Abi,
  mutationConfig: FFCAMutationConfig,
  log: { data: Hex.Hex; topics: readonly Hex.Hex[] },
): {
  index: bigint;
  args: unknown;
  signature: unknown;
  resolution?: unknown;
} {
  const decoded = decodeEventLog({
    abi: abi as FFCAAbi,
    eventName: "ForceInclusionQueued",
    data: log.data,
    topics: log.topics as [`0x${string}`, ...`0x${string}`[]],
  });
  const args = decoded.args as {
    index: bigint;
    mutationData: Hex.Hex;
    sig: unknown;
  };

  return {
    index: args.index,
    signature: args.sig,
    ...decodeMutationCalldata(mutationConfig, args.mutationData),
  };
}

// Build a structured Batch value from resolved mutations.
// Each signature is projected from a keyed record to a positional tuple
// matching the ABI declaration order.
export function encodeBatchArg(
  abi: Abi.Abi,
  mutations: MutationWithResolution[],
): {
  mutations: number[];
  mutationData: Hex.Hex[];
  signatures: readonly unknown[][];
} {
  const sigParams = getSignatureAbiParameters(abi);
  return {
    mutations: mutations.map((m) => m.config.tag),
    mutationData: mutations.map((m) => encodeMutationCalldata(m)),
    signatures: mutations.map(
      (m) => abiTupleFromRecord(sigParams, m.signature) as unknown[],
    ),
  };
}
