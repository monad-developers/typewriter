import { AbiFunction, AbiParameters, type Hex } from "ox";
import type { Authorization, ExecutableMutation } from "./types";
import {
  AUTHORIZATION_ABI_PARAMS,
  TYPEWRITER_ABI,
} from "./typewriter-constants";

// Resolved once: looking up the ABI item and hashing its selector on each
// call costs more than the encoding itself.
const EXECUTE_FUNCTION = AbiFunction.fromAbi(TYPEWRITER_ABI, "execute");
const ENQUEUE_FUNCTION = AbiFunction.fromAbi(TYPEWRITER_ABI, "enqueue");

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
    { checksumAddress: false },
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
    { checksumAddress: false },
  ) as unknown as [Omit<Authorization, "expiration"> & { expiration: number }];
  // ox decodes `uint40` as a number.
  return { ...authorization, expiration: BigInt(authorization.expiration) };
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
  return AbiFunction.encodeData(EXECUTE_FUNCTION, [
    batches,
    forceExecuteIndexes,
  ]);
}

export function encodeEnqueueCalldata(mutation: ExecutableMutation): Hex.Hex {
  return AbiFunction.encodeData(ENQUEUE_FUNCTION, [
    mutation.config.id,
    encodeMutationCalldata(mutation),
    encodeAuthorizationCalldata(mutation.authorization),
  ]);
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
