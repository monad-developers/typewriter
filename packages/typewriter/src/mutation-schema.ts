import type { AbiParameter } from "abitype";
import { Effect, Schema, SchemaGetter, SchemaIssue } from "effect";
import type { Hex } from "ox";
import { KeyType } from "./typewriter-constants";
import type {
  Authorization,
  ExecuteInput,
  MutationParamsForName,
} from "./typewriter-types";

/**
 * The schema of an `execute` input for the mutation `name` with `params`. It
 * decodes a `TypewriterMutationInput` to a `TypewriterMutation`, with each
 * decimal string as a bigint, and encodes with `ox` to the bytes it means. Without
 * it, `ox` encodes a missing or non-string `string` as text, copies any
 * string into the calldata as `bytes`, `bytesN` or `address` without checking
 * it is hex, and turns `""` or `true` into an integer.
 *
 * Whether the signature verifies, and its length for the credential's key
 * type, is the contract's to decide.
 */
export function executeInputSchema<
  const name extends string,
  const params extends readonly AbiParameter[],
>(
  name: name,
  params: params,
): Schema.Codec<
  TypewriterMutationFields<name, params>,
  ExecuteInput<TypewriterMutationFields<name, params>>
> {
  // An app's `params` are only known at runtime, so their types are too.
  return Schema.Struct({
    params: Object.hasOwn(BUILTIN_PARAMS_SCHEMAS, name)
      ? BUILTIN_PARAMS_SCHEMAS[name as keyof typeof BUILTIN_PARAMS_SCHEMAS]
      : tupleSchema(params),
    authorization: AUTHORIZATION_SCHEMA,
  }) as never;
}

type TypewriterMutationFields<
  name extends string,
  params extends readonly AbiParameter[],
> = {
  params: MutationParamsForName<name, { params: params }>;
  authorization: Authorization;
};

/**
 * Whether a value is one of `names`. Not `name in mutations`, which finds
 * `Object.prototype` names too.
 */
export function mutationNameGuard(names: readonly string[]) {
  return Schema.is(Schema.Literals(names));
}

/** A schema that decodes with no services. */
type Codec = Schema.Codec<unknown, unknown, never, never>;

/** A value of `param`, in a shape `ox` encodes. */
function abiParameterSchema(param: AbiParameter): Codec {
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
      components: readonly AbiParameter[];
    };
    return tupleSchema(components);
  }
  if (param.type === "bool") return Schema.Boolean;
  if (param.type === "string") return Schema.String;
  if (param.type === "address") return ADDRESS_SCHEMA;
  const bytes = /^bytes(\d*)$/.exec(param.type);
  if (bytes !== null) {
    return bytes[1] === "" ? BYTES_SCHEMA : bytesNSchema(Number(bytes[1]));
  }
  const integer = /^(u?)int(\d*)$/.exec(param.type);
  if (integer !== null) {
    const signed = integer[1] === "";
    const bits = Number(integer[2] || 256);
    return bits <= 48
      ? smallIntegerSchema(signed, bits)
      : bigIntegerSchema(signed, bits);
  }
  throw new Error(`unsupported ABI type ${param.type}`);
}

/** A tuple, as an object by component name, or an array by position if a component has no name. */
function tupleSchema(components: readonly AbiParameter[]): Codec {
  if (components.some(({ name }) => !name)) {
    return Schema.Tuple(components.map(abiParameterSchema));
  }
  return Schema.Struct(
    Object.fromEntries(
      components.map((component) => [
        component.name!,
        abiParameterSchema(component),
      ]),
    ),
  );
}

function integerRange(signed: boolean, bits: number) {
  const min = signed ? -(1n << BigInt(bits - 1)) : 0n;
  const max = (1n << BigInt(signed ? bits - 1 : bits)) - 1n;
  const type = `${signed ? "int" : "uint"}${bits}`;
  return Schema.makeFilter(
    (integer: bigint | number) =>
      (integer >= min && integer <= max) ||
      `Expected ${type} between ${min} and ${max}`,
  );
}

/** An integer of up to 48 bits, a number as in abitype. */
function smallIntegerSchema(
  signed: boolean,
  bits: number,
): Schema.Codec<number, number> {
  return Schema.Number.check(
    Schema.makeFilter(
      (value) =>
        Number.isInteger(value) ||
        `Expected an integer for ${signed ? "int" : "uint"}${bits}`,
    ),
    integerRange(signed, bits),
  );
}

/** An integer of over 48 bits, a bigint as in abitype, or a decimal string. */
function bigIntegerSchema(
  signed: boolean,
  bits: number,
): Schema.Codec<bigint, bigint | string> {
  return Schema.Union([Schema.BigInt, Schema.String]).pipe(
    Schema.decodeTo(Schema.BigInt.check(integerRange(signed, bits)), {
      decode: SchemaGetter.transformEffect((value) =>
        typeof value === "bigint" || /^-?\d+$/.test(value)
          ? Effect.succeed(BigInt(value))
          : Effect.fail(
              new SchemaIssue.InvalidValue(
                {
                  message: `Expected a decimal string for ${signed ? "int" : "uint"}${bits}`,
                },
                value,
              ),
            ),
      ),
      encode: SchemaGetter.transform((integer) => integer),
    }),
  );
}

function hexSchema(pattern: RegExp, expected: string) {
  return Schema.declare(
    (value): value is Hex.Hex =>
      typeof value === "string" && pattern.test(value),
    { expected },
  );
}

const ADDRESS_SCHEMA = hexSchema(/^0x[0-9a-fA-F]{40}$/, "an address");

const BYTES_SCHEMA = hexSchema(
  /^0x(?:[0-9a-fA-F]{2})*$/,
  "even-length hex bytes",
);

function bytesNSchema(size: number) {
  return hexSchema(
    new RegExp(`^0x[0-9a-fA-F]{${2 * size}}$`),
    `${size} hex bytes`,
  );
}

const KEY_TYPE_SCHEMA = Schema.Literals([
  KeyType.P256,
  KeyType.WebAuthnP256,
  KeyType.Secp256k1,
]);

const AUTHORIZATION_SCHEMA = Schema.Struct({
  accountID: bytesNSchema(32),
  credentialID: bigIntegerSchema(false, 64),
  nonce: bigIntegerSchema(false, 256),
  expiration: smallIntegerSchema(false, 40),
  signature: BYTES_SCHEMA,
});

const BUILTIN_PARAMS_SCHEMAS = {
  CreateAccount: Schema.Struct({
    keyType: KEY_TYPE_SCHEMA,
    publicKey: BYTES_SCHEMA,
  }),
  AddCredential: Schema.Struct({
    expiration: smallIntegerSchema(false, 40),
    keyType: KEY_TYPE_SCHEMA,
    permissions: bigIntegerSchema(false, 256),
    publicKey: BYTES_SCHEMA,
  }),
  RemoveCredential: Schema.Struct({
    credentialID: bigIntegerSchema(false, 64),
  }),
};
