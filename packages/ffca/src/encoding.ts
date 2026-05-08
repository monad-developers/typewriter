import { AbiParameters, type Hex } from "ox";
import type { FFCAMutationConfig } from "./config";
import type { ResolvedMutation } from "./types";

// Records keyed by param name are ffca's canonical shape for both args and
// signatures (the form clients post and the form `apply`/`resolve` consume).
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

// ffca expects the contract's `execute` to take `Bundle[]` where
//   Bundle = { uint8[] mutations, bytes[] mutationData, Sig[] signatures }
// and `Sig` is shaped by `FFCAConfig.signature.params` — a tuple in
// declaration order with whatever fields the app's contract expects.
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

// Same Bundle shape as above, but as a structured value rather than bytes.
// Use when the caller will pass it through viem's `encodeFunctionData` (which
// needs unencoded values to slot into an ABI shape) — e.g. to wrap multiple
// bundles into a single `execute(Bundle[])` call. Each signature is a
// positional tuple matching `sigParams` declaration order.
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
