import { AbiParameters, type Hex } from "ox";
import type { FFCAMutationConfig } from "./config";
import type { ResolvedMutation } from "./types";

// Args may be passed positionally (array) or by name (object); normalize to
// the positional form ABI-encode expects, in the order declared by `params`.
function toTuple(
  params: readonly AbiParameters.Parameter[],
  args: unknown,
): readonly unknown[] {
  if (Array.isArray(args)) return args;
  const record = args as Record<string, unknown>;
  return params.map((p) => record[p.name ?? ""]);
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
      [...params, ...resolutionParams],
      [...toTuple(params, args), ...toTuple(resolutionParams, resolution)],
    );
  }

  return AbiParameters.encode(params, toTuple(params, args));
}

// ffca expects the contract's `execute` to take `Bundle[]` where
//   Bundle = { uint8[] mutations, bytes[] mutationData, bytes[] signatures }
// Signatures pass through opaquely; account-system shaping is the caller's
// problem.
const BUNDLE_PARAMS = AbiParameters.from(
  "(uint8[] mutations, bytes[] mutationData, bytes[] signatures)",
);

export function encodeBundleCalldata(mutations: ResolvedMutation[]): Hex.Hex {
  return AbiParameters.encode(BUNDLE_PARAMS, [encodeBundleArg(mutations)]);
}

// Same Bundle shape as above, but as a structured value rather than bytes.
// Use when the caller will pass it through viem's `encodeFunctionData` (which
// needs unencoded values to slot into an ABI shape) — e.g. to wrap multiple
// bundles into a single `execute(Bundle[])` call.
export function encodeBundleArg(mutations: ResolvedMutation[]): {
  mutations: number[];
  mutationData: Hex.Hex[];
  signatures: Hex.Hex[];
} {
  return {
    mutations: mutations.map((m) => m.config.tag),
    mutationData: mutations.map((m) =>
      encodeMutationCalldata(m.config, m.args, m.resolution),
    ),
    signatures: mutations.map((m) => m.signature),
  };
}
