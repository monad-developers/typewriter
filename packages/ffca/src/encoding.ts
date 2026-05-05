import { AbiParameters, type Hex } from "ox";
import type { FFCAMutationConfig } from "./config";
import type { ResolvedMutation } from "./types";

export function encodeMutationCalldata(
  mutation: FFCAMutationConfig,
  args: unknown,
  resolution?: unknown,
): Hex.Hex {
  if ("resolution" in mutation) {
    return AbiParameters.encode(
      [
        ...(mutation.params as readonly AbiParameters.Parameter[]),
        ...(mutation.resolution as readonly AbiParameters.Parameter[]),
      ],
      [...(args as readonly unknown[]), ...(resolution as readonly unknown[])],
    );
  }

  return AbiParameters.encode(
    mutation.params as readonly AbiParameters.Parameter[],
    args as readonly unknown[],
  );
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
