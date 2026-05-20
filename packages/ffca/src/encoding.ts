import { AbiParameters, type Hex } from "ox";
import type { FFCAMutationConfig } from "./config";
import type { ResolvedMutation } from "./types";

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
  mutation: FFCAMutationConfig,
  args: unknown,
  resolution?: unknown,
): Hex.Hex {
  const params = mutation.params as readonly AbiParameters.Parameter[];
  if ("resolution" in mutation) {
    const resolutionParams =
      mutation.resolution as readonly AbiParameters.Parameter[];
    return AbiParameters.encode(
      [
        ...calldataStructParams(params),
        ...calldataStructParams(resolutionParams),
      ],
      [args, resolution],
    );
  }

  return AbiParameters.encode(calldataStructParams(params), [args]);
}

export function decodeMutationCalldata(
  mutation: FFCAMutationConfig,
  calldata: Hex.Hex,
): { args: unknown; resolution?: unknown } {
  const params = mutation.params as readonly AbiParameters.Parameter[];
  if ("resolution" in mutation) {
    const resolutionParams =
      mutation.resolution as readonly AbiParameters.Parameter[];
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

// ffca expects the contract's `execute` to take `(Bundle[], uint256[])` where
//   Bundle = { uint8[] mutations, bytes[] mutationData, Sig[] signatures }
// `Sig` is shaped by `FFCAConfig.signature.params`, and the second argument is
// a list of force-inclusion queue indexes the scheduler wants to execute.
function bundleParams(
  sigParams: readonly AbiParameters.Parameter[],
): readonly AbiParameters.Parameter[] {
  return AbiParameters.from([
    {
      type: "tuple",
      components: [
        { name: "mutations", type: "uint8[]" },
        { name: "mutationData", type: "bytes[]" },
        {
          name: "signatures",
          type: "tuple[]",
          components: sigParams as AbiParameters.Parameter[],
        },
      ],
    },
  ]);
}

export function encodeBundleCalldata(
  mutations: ResolvedMutation[],
  sigParams: readonly AbiParameters.Parameter[],
): Hex.Hex {
  return AbiParameters.encode(bundleParams(sigParams), [
    encodeBundleArg(mutations, sigParams),
  ]);
}

// `execute(Bundle[], uint256[])` as a viem-compatible abi item, derived from
// `sigParams`. The contract's execute selector is a function of the bundle
// shape (which is fully determined by `sigParams`), so ffca can build this
// without consulting `FFCAConfig.abi` — useful when calldata is needed for
// internal revm execution, without forcing
// stub-config tests to declare an `execute` entry on their abi.
export function executeAbi(sigParams: readonly AbiParameters.Parameter[]) {
  return [
    {
      type: "function",
      name: "execute",
      stateMutability: "nonpayable",
      inputs: [
        {
          name: "bundles",
          type: "tuple[]",
          components: [
            { name: "mutations", type: "uint8[]" },
            { name: "mutationData", type: "bytes[]" },
            {
              name: "signatures",
              type: "tuple[]",
              components: sigParams as AbiParameters.Parameter[],
            },
          ],
        },
        { name: "forceExecuteIndexes", type: "uint256[]" },
      ],
      outputs: [],
    },
  ] as const;
}

export function forceInclusionQueuedAbi(
  sigParams: readonly AbiParameters.Parameter[],
) {
  return [
    {
      type: "event",
      name: "ForceInclusionQueued",
      inputs: [
        { name: "index", type: "uint256", indexed: false },
        { name: "mutation", type: "uint8", indexed: false },
        { name: "mutationData", type: "bytes", indexed: false },
        {
          name: "sig",
          type: "tuple",
          indexed: false,
          components: sigParams as AbiParameters.Parameter[],
        },
        { name: "enqueuedBlock", type: "uint256", indexed: false },
      ],
    },
  ] as const;
}

// Same Bundle shape as above, but as a structured value rather than bytes.
// Use when the caller will pass it through viem's `encodeFunctionData` (which
// needs unencoded values to slot into an ABI shape) — e.g. to wrap multiple
// bundles into a single `execute(Bundle[], uint256[])` call. Each signature is
// a positional tuple matching `sigParams` declaration order.
export function encodeBundleArg(
  mutations: ResolvedMutation[],
  sigParams: readonly AbiParameters.Parameter[],
): {
  mutations: number[];
  mutationData: Hex.Hex[];
  signatures: readonly unknown[][];
} {
  return {
    mutations: mutations.map((m) => m.config.tag),
    mutationData: mutations.map((m) =>
      encodeMutationCalldata(m.config, m.args, m.resolution),
    ),
    signatures: mutations.map(
      (m) => abiTupleFromRecord(sigParams, m.signature) as unknown[],
    ),
  };
}
