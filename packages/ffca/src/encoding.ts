import { AbiParameters, type Hex } from "ox";
import type { FFCAMutationConfig } from "./config";

export function encodeMutation(
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
