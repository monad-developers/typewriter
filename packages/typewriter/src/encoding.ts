import { AbiFunction, AbiParameters, type Hex } from "ox";
import {
  AUTHORIZATION_ABI_PARAMS,
  TYPEWRITER_ABI,
} from "./typewriter-constants";
import type { Authorization, RuntimeMutation } from "./typewriter-types";

/** The parts of a mutation that its calldata encodes. */
type EncodableMutation = Pick<
  RuntimeMutation,
  "config" | "params" | "authorization"
>;

const EXECUTE_FUNCTION = AbiFunction.fromAbi(TYPEWRITER_ABI, "execute");
const ENQUEUE_FUNCTION = AbiFunction.fromAbi(TYPEWRITER_ABI, "enqueue");

function calldataStructParams<
  const params extends readonly AbiParameters.Parameter[],
>(params: params) {
  return [{ type: "tuple", components: params }] as const;
}

export function encodeMutationCalldata(mutation: EncodableMutation): Hex.Hex {
  // `config.params` is only known at runtime, so its value type is too.
  return AbiParameters.encode(calldataStructParams(mutation.config.params), [
    mutation.params,
  ] as never);
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
  // ox types `uint40` as a number.
  return AbiParameters.encode(calldataStructParams(AUTHORIZATION_ABI_PARAMS), [
    { ...authorization, expiration: Number(authorization.expiration) },
  ]);
}

export function decodeAuthorizationCalldata(calldata: Hex.Hex): Authorization {
  const [authorization] = AbiParameters.decode(
    calldataStructParams(AUTHORIZATION_ABI_PARAMS),
    calldata,
    { checksumAddress: false },
  );
  // ox decodes `uint40` as a number.
  return { ...authorization, expiration: BigInt(authorization.expiration) };
}

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

export function encodeEnqueueCalldata(args: {
  mutation: number;
  mutationData: Hex.Hex;
  authorizationData: Hex.Hex;
}): Hex.Hex {
  return AbiFunction.encodeData(ENQUEUE_FUNCTION, [
    args.mutation,
    args.mutationData,
    args.authorizationData,
  ]);
}

export function encodeBatchArg(mutations: readonly EncodableMutation[]): {
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
