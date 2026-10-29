import { AbiFunction, AbiParameters, Address, Bytes, type Hex } from "ox";
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

/** An ABI type: an array of `item`s, a tuple, or a value type like `uint8`. */
type AbiType =
  | {
      kind: "array";
      item: AbiParameters.Parameter;
      /** Unset for a dynamic array. */
      length: number | undefined;
    }
  | { kind: "tuple"; components: readonly AbiParameters.Parameter[] }
  | { kind: "value"; type: string };

function abiType(param: AbiParameters.Parameter): AbiType {
  const array = /^(.*)\[(\d*)\]$/.exec(param.type);
  if (array !== null) {
    return {
      kind: "array",
      item: { ...param, type: array[1]! },
      length: array[2] === "" ? undefined : Number(array[2]),
    };
  }
  if (param.type === "tuple") {
    const { components } = param as {
      components: readonly AbiParameters.Parameter[];
    };
    return { kind: "tuple", components };
  }
  return { kind: "value", type: param.type };
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
      assertCleanAt(component, data, start + Number(word(data, head)));
      head += 32;
    } else {
      assertCleanAt(component, data, head);
      head += staticSize(component);
    }
  }
}

/** Checks `param` encoded at `position`: its tail if dynamic, else in place. */
function assertCleanAt(
  param: AbiParameters.Parameter,
  data: Bytes.Bytes,
  position: number,
): void {
  const type = abiType(param);
  if (type.kind === "array") {
    // A dynamic array's length precedes its items.
    const length = type.length ?? Number(word(data, position));
    const items = Array<AbiParameters.Parameter>(length).fill(type.item);
    assertCleanTuple(
      items,
      data,
      type.length === undefined ? position + 32 : position,
    );
  } else if (type.kind === "tuple") {
    assertCleanTuple(type.components, data, position);
  } else if (type.type !== "bytes" && type.type !== "string") {
    if (!isClean(type.type, word(data, position))) {
      throw new Error(`dirty ${type.type} at byte ${position}`);
    }
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
  const type = abiType(param);
  if (type.kind === "array") {
    return type.length === undefined || isDynamic(type.item);
  }
  if (type.kind === "tuple") return type.components.some(isDynamic);
  return type.type === "bytes" || type.type === "string";
}

/** The size of a static `param` in the head of its tuple. */
function staticSize(param: AbiParameters.Parameter): number {
  const type = abiType(param);
  if (type.kind === "array") return type.length! * staticSize(type.item);
  if (type.kind === "tuple") {
    return type.components.reduce(
      (size, component) => size + staticSize(component),
      0,
    );
  }
  return 32;
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
