import { AbiFunction, AbiParameters, Address, type Hex } from "ox";
import { abiType, decodeAbiParameters } from "./abi-decode";
import {
  AUTHORIZATION_ABI_PARAMS,
  TYPEWRITER_ABI,
} from "./typewriter-constants";
import type { Authorization, RuntimeMutation } from "./typewriter-types";

/** The parts of a mutation that its calldata encodes. */
type EncodableMutation = Pick<RuntimeMutation, "config" | "params">;

/** A mutation with the bytes the contract decodes it from. */
type EncodedMutation = {
  config: Pick<RuntimeMutation["config"], "id">;
  mutationData: Hex.Hex;
  authorizationData: Hex.Hex;
};

const EXECUTE_FUNCTION = AbiFunction.fromAbi(TYPEWRITER_ABI, "execute");
const ENQUEUE_FUNCTION = AbiFunction.fromAbi(TYPEWRITER_ABI, "enqueue");

function calldataStructParams<
  const params extends readonly AbiParameters.Parameter[],
>(params: params) {
  return [{ type: "tuple", components: params }] as const;
}

/**
 * Throws unless `value` is what `ox` encodes for `param` as given. `ox` checks
 * integers and `bool`s itself, but encodes a missing or non-string `string`
 * as text, and copies any string into the calldata as `bytes` or `address`.
 */
function assertEncodable(
  param: AbiParameters.Parameter,
  value: unknown,
  path: string,
): void {
  const type = abiType(param);
  if (type.kind === "array") {
    if (
      !Array.isArray(value) ||
      (type.length !== undefined && value.length !== type.length)
    ) {
      throw new Error(
        `${path} must be an array of ${type.length ?? "any"} ${type.item.type}`,
      );
    }
    for (const [i, entry] of value.entries()) {
      assertEncodable(type.item, entry, `${path}[${i}]`);
    }
  } else if (type.kind === "tuple") {
    if (typeof value !== "object" || value === null) {
      throw new Error(`${path} must be an object`);
    }
    for (const [i, component] of type.components.entries()) {
      const entry = Array.isArray(value)
        ? value[i]
        : (value as Record<string, unknown>)[component.name ?? ""];
      assertEncodable(component, entry, `${path}.${component.name ?? i}`);
    }
  } else {
    const expected = unencodableValue(type.type, value);
    if (expected !== undefined) throw new Error(`${path} must be ${expected}`);
  }
}

/** What a `type` value must be, if `value` isn't one `ox` encodes as given. */
function unencodableValue(type: string, value: unknown): string | undefined {
  if (type === "string") {
    return typeof value === "string" ? undefined : "a string";
  }
  if (type === "address") {
    return typeof value === "string" &&
      Address.validate(value, { strict: false })
      ? undefined
      : "an address";
  }
  const bytes = /^bytes(\d*)$/.exec(type);
  if (bytes !== null) {
    const size = bytes[1] === "" ? undefined : Number(bytes[1]);
    return typeof value === "string" &&
      /^0x(?:[0-9a-fA-F]{2})*$/.test(value) &&
      (size === undefined || value.length === 2 + 2 * size)
      ? undefined
      : `${size ?? "even-length"} hex bytes`;
  }
  return undefined;
}

export function encodeMutationCalldata(mutation: EncodableMutation): Hex.Hex {
  const params = calldataStructParams(mutation.config.params);
  assertEncodable(params[0], mutation.params, "params");
  // `config.params` is only known at runtime, so its value type is too.
  return AbiParameters.encode(params, [mutation.params] as never);
}

export function decodeMutationCalldata(
  mutationConfig: {
    params: readonly AbiParameters.Parameter[];
  },
  calldata: Hex.Hex,
): { params: unknown } {
  const [decodedParams] = decodeAbiParameters(
    calldataStructParams(mutationConfig.params),
    calldata,
  );
  return { params: decodedParams };
}

export function encodeAuthorizationCalldata(
  authorization: Authorization,
): Hex.Hex {
  const params = calldataStructParams(AUTHORIZATION_ABI_PARAMS);
  assertEncodable(params[0], authorization, "authorization");
  // ox types `uint40` as a number.
  return AbiParameters.encode(params, [
    { ...authorization, expiration: Number(authorization.expiration) },
  ]);
}

export function decodeAuthorizationCalldata(calldata: Hex.Hex): Authorization {
  const [authorization] = decodeAbiParameters(
    calldataStructParams(AUTHORIZATION_ABI_PARAMS),
    calldata,
  ) as [Omit<Authorization, "expiration"> & { expiration: number }];
  // `uint40` decodes as a number.
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

export function encodeBatchArg(mutations: readonly EncodedMutation[]): {
  mutations: readonly number[];
  mutationData: readonly Hex.Hex[];
  authorizationData: readonly Hex.Hex[];
} {
  return {
    mutations: mutations.map((mutation) => mutation.config.id),
    mutationData: mutations.map((mutation) => mutation.mutationData),
    authorizationData: mutations.map((mutation) => mutation.authorizationData),
  };
}
