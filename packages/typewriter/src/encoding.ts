import { AbiFunction, AbiParameters, Address, Bytes, Hex } from "ox";
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
  const array = /^(.*)\[(\d*)\]$/.exec(param.type);
  if (array !== null) {
    const [, item, length] = array;
    if (
      !Array.isArray(value) ||
      (length !== "" && value.length !== Number(length))
    ) {
      throw new Error(`${path} must be an array of ${length || "any"} ${item}`);
    }
    for (const [i, entry] of value.entries()) {
      assertEncodable({ ...param, type: item! }, entry, `${path}[${i}]`);
    }
    return;
  }
  if (param.type === "tuple") {
    if (typeof value !== "object" || value === null) {
      throw new Error(`${path} must be an object`);
    }
    const { components } = param as {
      components: readonly AbiParameters.Parameter[];
    };
    for (const [i, component] of components.entries()) {
      const entry = Array.isArray(value)
        ? value[i]
        : (value as Record<string, unknown>)[component.name ?? ""];
      assertEncodable(component, entry, `${path}.${component.name ?? i}`);
    }
    return;
  }
  if (param.type === "string" && typeof value !== "string") {
    throw new Error(`${path} must be a string`);
  }
  if (
    param.type === "address" &&
    !Address.validate(value as string, { strict: false })
  ) {
    throw new Error(`${path} must be an address`);
  }
  const bytes = /^bytes(\d*)$/.exec(param.type);
  if (bytes !== null) {
    const size = bytes[1] === "" ? undefined : Number(bytes[1]);
    if (
      typeof value !== "string" ||
      !Hex.validate(value, { strict: true }) ||
      value.length % 2 !== 0 ||
      (size !== undefined && Hex.size(value) !== size)
    ) {
      throw new Error(`${path} must be ${size ?? "even-length"} hex bytes`);
    }
  }
}

/**
 * Throws unless every value type in `data` is clean, as the contract's
 * `abi.decode` requires. `ox` decodes within the same bounds, but drops the
 * high bits of an integer or address and the low bits of a `bytesN`, where
 * `abi.decode` reverts. Like `abi.decode`, it accepts trailing bytes, any
 * in-bounds offset, and any padding after `bytes` and `string`.
 */
function assertClean(
  params: readonly AbiParameters.Parameter[],
  data: Bytes.Bytes,
): void {
  assertCleanTuple(params, data, 0);
}

function assertCleanTuple(
  components: readonly AbiParameters.Parameter[],
  data: Bytes.Bytes,
  start: number,
): void {
  let head = start;
  for (const component of components) {
    if (isDynamic(component)) {
      assertCleanDynamic(component, data, start + Number(word(data, head)));
      head += 32;
    } else {
      assertCleanStatic(component, data, head);
      head += staticSize(component);
    }
  }
}

function assertCleanDynamic(
  param: AbiParameters.Parameter,
  data: Bytes.Bytes,
  position: number,
): void {
  const array = /^(.*)\[(\d*)\]$/.exec(param.type);
  if (array !== null) {
    const [, item, length] = array;
    const items = Array<AbiParameters.Parameter>(
      length === "" ? Number(word(data, position)) : Number(length),
    ).fill({ ...param, type: item! });
    assertCleanTuple(items, data, length === "" ? position + 32 : position);
  } else if (param.type === "tuple") {
    assertCleanTuple(componentsOf(param), data, position);
  }
  // `bytes` and `string` have no value type to check.
}

function assertCleanStatic(
  param: AbiParameters.Parameter,
  data: Bytes.Bytes,
  position: number,
): void {
  const array = /^(.*)\[(\d+)\]$/.exec(param.type);
  if (array !== null) {
    const item = { ...param, type: array[1]! };
    for (let i = 0; i < Number(array[2]); i++) {
      assertCleanStatic(item, data, position + i * staticSize(item));
    }
    return;
  }
  if (param.type === "tuple") {
    assertCleanTuple(componentsOf(param), data, position);
    return;
  }
  if (!isClean(param.type, word(data, position))) {
    throw new Error(`dirty ${param.type} at byte ${position}`);
  }
}

/** Whether `abi.decode` accepts the word `value` as a `type`. */
function isClean(type: string, value: bigint): boolean {
  const integer = /^(u?)int(\d*)$/.exec(type);
  if (integer !== null) {
    const bits = Number(integer[2] || 256);
    return integer[1] === "u"
      ? BigInt.asUintN(bits, value) === value
      : BigInt.asIntN(bits, value) === BigInt.asIntN(256, value);
  }
  if (type === "address") return BigInt.asUintN(160, value) === value;
  if (type === "bool") return value <= 1n;
  const bytes = /^bytes(\d+)$/.exec(type);
  if (bytes !== null) {
    return BigInt.asUintN(256 - 8 * Number(bytes[1]), value) === 0n;
  }
  return true;
}

function isDynamic(param: AbiParameters.Parameter): boolean {
  if (param.type === "bytes" || param.type === "string") return true;
  const array = /^(.*)\[(\d*)\]$/.exec(param.type);
  if (array !== null) {
    return array[2] === "" || isDynamic({ ...param, type: array[1]! });
  }
  return param.type === "tuple" && componentsOf(param).some(isDynamic);
}

/** The size of a static `param` in the head of its tuple. */
function staticSize(param: AbiParameters.Parameter): number {
  const array = /^(.*)\[(\d+)\]$/.exec(param.type);
  if (array !== null) {
    return Number(array[2]) * staticSize({ ...param, type: array[1]! });
  }
  if (param.type === "tuple") {
    return componentsOf(param).reduce(
      (size, component) => size + staticSize(component),
      0,
    );
  }
  return 32;
}

function componentsOf(
  param: AbiParameters.Parameter,
): readonly AbiParameters.Parameter[] {
  return (param as { components: readonly AbiParameters.Parameter[] })
    .components;
}

function word(data: Bytes.Bytes, position: number): bigint {
  if (position + 32 > data.length) {
    throw new Error(`no word at byte ${position}`);
  }
  return Bytes.toBigInt(data.subarray(position, position + 32));
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
  const params = calldataStructParams(mutationConfig.params);
  const [decodedParams] = AbiParameters.decode(params, calldata, {
    checksumAddress: false,
  });
  assertClean(params, Bytes.fromHex(calldata));
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
  const params = calldataStructParams(AUTHORIZATION_ABI_PARAMS);
  const [authorization] = AbiParameters.decode(params, calldata, {
    checksumAddress: false,
  });
  assertClean(params, Bytes.fromHex(calldata));
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
