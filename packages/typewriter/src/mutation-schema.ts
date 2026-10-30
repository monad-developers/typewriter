import { Schema } from "effect";
import type { AbiParameters } from "ox";
import { AUTHORIZATION_ABI_PARAMS } from "./typewriter-constants";

/**
 * The schema of an `execute` input for a mutation with `params`. A value
 * that passes encodes with `ox` to the bytes it means. Without it, `ox`
 * encodes a missing or non-string `string` as text, copies any string into
 * the calldata as `bytes`, `bytesN` or `address` without checking it is hex,
 * and turns `""` or `true` into an integer.
 *
 * It only checks the shape. Whether the signature verifies, and its length
 * for the credential's key type, is the contract's to decide.
 */
export function executeInputSchema(params: readonly AbiParameters.Parameter[]) {
  return Schema.Struct({
    params: tupleSchema(params),
    authorization: AUTHORIZATION_SCHEMA,
  });
}

/** A schema that decodes with no services. */
type Codec = Schema.Codec<unknown, unknown, never, never>;

/** A value of `param`, in a shape `ox` encodes. */
function abiParameterSchema(param: AbiParameters.Parameter): Codec {
  const array = /^(.*)\[(\d*)\]$/.exec(param.type);
  if (array !== null) {
    const items = Schema.Array(
      abiParameterSchema({ ...param, type: array[1]! }),
    );
    if (array[2] === "") return items;
    const length = Number(array[2]);
    return items.check(Schema.isMinLength(length), Schema.isMaxLength(length));
  }
  if (param.type === "tuple") {
    const { components } = param as {
      components: readonly AbiParameters.Parameter[];
    };
    return tupleSchema(components);
  }
  if (param.type === "bool") return Schema.Boolean;
  if (param.type === "string") return Schema.String;
  if (param.type === "address") {
    return matching(/^0x[0-9a-fA-F]{40}$/, "an address");
  }
  const bytes = /^bytes(\d*)$/.exec(param.type);
  if (bytes !== null) {
    return bytes[1] === ""
      ? matching(/^0x(?:[0-9a-fA-F]{2})*$/, "even-length hex bytes")
      : matching(
          new RegExp(`^0x[0-9a-fA-F]{${2 * Number(bytes[1])}}$`),
          `${bytes[1]} hex bytes`,
        );
  }
  const integer = /^(u?)int(\d*)$/.exec(param.type);
  if (integer !== null) {
    return integerSchema(integer[1] === "", Number(integer[2] || 256));
  }
  throw new Error(`unsupported ABI type ${param.type}`);
}

/** A tuple, as an object by component name, or an array by position. */
function tupleSchema(components: readonly AbiParameters.Parameter[]) {
  const positional = Schema.Tuple(components.map(abiParameterSchema));
  if (components.some(({ name }) => !name)) return positional;
  return Schema.Union([structSchema(components), positional]);
}

function structSchema(components: readonly AbiParameters.Parameter[]) {
  return Schema.Struct(
    Object.fromEntries(
      components.map((component) => [
        component.name!,
        abiParameterSchema(component),
      ]),
    ),
  );
}

// An object only: the encoder spreads it.
const AUTHORIZATION_SCHEMA = structSchema(AUTHORIZATION_ABI_PARAMS);

const INTEGER_STRING = /^(?:-?\d+|0x[0-9a-fA-F]+)$/;

/**
 * An integer in range: a bigint, a safe integer, or a decimal or `0x`
 * string. Not `""`, `true`, or a number past 2^53, which `ox` would encode
 * as some other integer.
 */
function integerSchema(signed: boolean, bits: number) {
  const min = signed ? -(1n << BigInt(bits - 1)) : 0n;
  const max = (1n << BigInt(signed ? bits - 1 : bits)) - 1n;
  const type = `${signed ? "int" : "uint"}${bits}`;
  return Schema.Union([Schema.BigInt, Schema.Number, Schema.String]).check(
    Schema.makeFilter((value) => {
      const integer = toInteger(value);
      if (integer === undefined) return `Expected an integer for ${type}`;
      return (
        (integer >= min && integer <= max) ||
        `Expected ${type} between ${min} and ${max}`
      );
    }),
  );
}

function toInteger(value: bigint | number | string): bigint | undefined {
  if (typeof value === "bigint") return value;
  if (typeof value === "number") {
    return Number.isSafeInteger(value) ? BigInt(value) : undefined;
  }
  return INTEGER_STRING.test(value) ? BigInt(value) : undefined;
}

function matching(pattern: RegExp, expected: string) {
  return Schema.String.check(
    Schema.makeFilter((value) => pattern.test(value) || `Expected ${expected}`),
  );
}
