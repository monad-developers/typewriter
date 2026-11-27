import { AbiFunction, AbiParameters, type Address, Hex } from "ox";
import {
  AUTHORIZATION_ABI_PARAMS,
  KeyType,
  SCHEDULER_CREDENTIAL_ABI_PARAMS,
  type SchedulerRole,
  SECP256K1_PUBLIC_KEY_PARAMS,
  TYPEWRITER_ABI,
} from "./typewriter-constants";
import type {
  Authorization,
  RuntimeMutation,
  SchedulerCredential,
} from "./typewriter-types";

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
  return AbiParameters.encode(calldataStructParams(AUTHORIZATION_ABI_PARAMS), [
    authorization,
  ]);
}

export function decodeAuthorizationCalldata(calldata: Hex.Hex): Authorization {
  const [authorization] = AbiParameters.decode(
    calldataStructParams(AUTHORIZATION_ABI_PARAMS),
    calldata,
    { checksumAddress: false },
  );
  return authorization;
}

export type BatchArg = {
  mutations: readonly number[];
  mutationData: readonly Hex.Hex[];
  authorizationData: readonly Hex.Hex[];
};

export const EMPTY_BATCH: BatchArg = {
  mutations: [],
  mutationData: [],
  authorizationData: [],
};

/** `struct SchedulerAuthorization`. An empty signature works only when the credential's address sends the call. */
export type SchedulerAuthorization = {
  credentialID: bigint;
  signature: Hex.Hex;
};

/** `timestamp` is the one the settlement executes at, which the contract checks against its block's. */
export function encodeExecuteCalldata(
  fromExecutionHash: Hex.Hex,
  timestamp: bigint,
  batch: BatchArg,
  forceExecuteIndexes: readonly bigint[],
  authorization: SchedulerAuthorization,
): Hex.Hex {
  return AbiFunction.encodeData(EXECUTE_FUNCTION, [
    fromExecutionHash,
    Number(timestamp),
    batch,
    forceExecuteIndexes,
    authorization,
  ]);
}

/** The `publicKey` of a `KeyType.Secp256k1` credential for `address`. */
export function encodeSecp256k1PublicKey(address: Address.Address): Hex.Hex {
  return AbiParameters.encode(SECP256K1_PUBLIC_KEY_PARAMS, [address]);
}

/**
 * A secp256k1 signature as `verifySecp256k1` takes it: the standard 65 bytes
 * `r ‖ s ‖ v`, with `v` 27 or 28, as wallets, viem and `cast wallet sign` return it.
 */
export function encodeSecp256k1Signature(
  r: bigint,
  s: bigint,
  yParity: number,
): Hex.Hex {
  return Hex.concat(
    Hex.fromNumber(r, { size: 32 }),
    Hex.fromNumber(s, { size: 32 }),
    Hex.fromNumber(yParity + 27, { size: 1 }),
  );
}

/**
 * The app constructor's arguments: the scheduler's credentials, as
 * `constructor(SchedulerCredential[] memory schedulerCredentials)` takes
 * them. Append them to the app's bytecode to deploy it.
 */
export function encodeSchedulerCredentials(
  credentials: readonly SchedulerCredential[],
): Hex.Hex {
  return AbiParameters.encode(
    [{ type: "tuple[]", components: SCHEDULER_CREDENTIAL_ABI_PARAMS }],
    [credentials],
  );
}

/**
 * A scheduler credential for the secp256k1 key of `address`, with `role` and
 * no expiration unless `expiration` is set.
 */
export function secp256k1SchedulerCredential(
  address: Address.Address,
  role: SchedulerRole,
  expiration = 0,
): SchedulerCredential {
  return {
    expiration,
    keyType: KeyType.Secp256k1,
    role,
    publicKey: encodeSecp256k1PublicKey(address),
  };
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

export function encodeBatchArg(
  mutations: readonly EncodableMutation[],
): BatchArg {
  return {
    mutations: mutations.map((mutation) => mutation.config.id),
    mutationData: mutations.map((m) => encodeMutationCalldata(m)),
    authorizationData: mutations.map((mutation) =>
      encodeAuthorizationCalldata(mutation.authorization),
    ),
  };
}
