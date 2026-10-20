import type { AbiParameter, AbiParameterToPrimitiveType } from "abitype";
import type { $Type, NotNull } from "drizzle-orm";
import {
  bigint,
  char,
  integer,
  jsonb,
  numeric,
  type PgBigInt64BuilderInitial,
  type PgBooleanBuilderInitial,
  type PgCharBuilderInitial,
  type PgColumnBuilderBase,
  type PgIntegerBuilderInitial,
  type PgJsonbBuilderInitial,
  type PgNumericBigIntBuilderInitial,
  type PgSmallIntBuilderInitial,
  type PgTextBuilderInitial,
  boolean as pgBoolean,
  smallint,
  text,
} from "drizzle-orm/pg-core";

type Hex = `0x${string}`;

type AbiPgType =
  | "boolean"
  | "smallint"
  | "integer"
  | "bigint"
  | "numeric(78,0)"
  | `char(${number})`
  | "text"
  | "jsonb";

type NotNullBuilder<Builder extends PgColumnBuilderBase> = NotNull<Builder>;

type RuntimeColumnBuilder = PgColumnBuilderBase & {
  notNull(): PgColumnBuilderBase;
};

type AbiPgJsonValue<T> = T extends bigint
  ? string
  : T extends readonly (infer Item)[]
    ? readonly AbiPgJsonValue<Item>[]
    : T extends object
      ? { readonly [Key in keyof T]: AbiPgJsonValue<T[Key]> }
      : T;

type AbiParameterToPgJsonType<Param extends AbiParameter> = AbiPgJsonValue<
  AbiParameterToPrimitiveType<Param>
>;

type PgTextBuilder = PgTextBuilderInitial<"", [string, ...string[]]>;

type JsonbBuilderFor<T> = $Type<PgJsonbBuilderInitial<"">, T>;

type HexCharBuilder = $Type<
  PgCharBuilderInitial<"", [string, ...string[]], number>,
  Hex
>;
type HexTextBuilder = $Type<PgTextBuilder, Hex>;

export type AbiParameterToColumn<Param extends AbiParameter> =
  Param["type"] extends `${string}[${string}]` | `tuple${string}`
    ? NotNullBuilder<JsonbBuilderFor<AbiParameterToPgJsonType<Param>>>
    : Param["type"] extends "bool"
      ? NotNullBuilder<PgBooleanBuilderInitial<"">>
      : Param["type"] extends "uint8" | "int8" | "int16"
        ? NotNullBuilder<PgSmallIntBuilderInitial<"">>
        : Param["type"] extends "uint16" | "uint24" | "int24" | "int32"
          ? NotNullBuilder<PgIntegerBuilderInitial<"">>
          : Param["type"] extends
                | "uint32"
                | "uint40"
                | "uint48"
                | "uint56"
                | "int40"
                | "int48"
                | "int56"
                | "int64"
            ? NotNullBuilder<PgBigInt64BuilderInitial<"">>
            : Param["type"] extends `uint${string}` | `int${string}`
              ? NotNullBuilder<PgNumericBigIntBuilderInitial<"">>
              : Param["type"] extends "bytes"
                ? NotNullBuilder<HexTextBuilder>
                : Param["type"] extends "string"
                  ? NotNullBuilder<PgTextBuilder>
                  : Param["type"] extends
                        | "address"
                        | `bytes${string}`
                        | "function"
                    ? NotNullBuilder<HexCharBuilder>
                    : never;

export type AbiParametersToColumns<Params extends readonly AbiParameter[]> = {
  [Index in keyof Params as Index extends `${number}`
    ? ParamColumnName<Params[Index], Index>
    : never]: Params[Index] extends AbiParameter
    ? AbiParameterToColumn<Params[Index]>
    : never;
};

type ParamColumnName<Param, Index extends string> = Param extends {
  name?: infer Name extends string;
}
  ? Name extends ""
    ? `arg${Index}`
    : Name
  : `arg${Index}`;

type AbiPgColumnInfo = {
  readonly pg: AbiPgType;
  readonly hex?: boolean;
};

export function abiParametersToColumns<
  const Params extends readonly AbiParameter[],
>(params: Params): AbiParametersToColumns<Params> {
  const columns: Record<string, PgColumnBuilderBase> = {};
  for (let index = 0; index < params.length; index++) {
    const param = params[index];
    if (param === undefined) continue;
    const name = paramColumnName(param, index);
    if (columns[name] !== undefined) {
      throw new Error(`duplicate ABI parameter column name: ${name}`);
    }
    columns[name] = abiParameterToColumn(param);
  }
  return columns as AbiParametersToColumns<Params>;
}

export function abiParameterToColumn<const Param extends AbiParameter>(
  param: Param,
): AbiParameterToColumn<Param> {
  assertSupportedParameter(param);
  return columnForInfo<Param>(
    abiTypeToPgType(param.type),
  ).notNull() as AbiParameterToColumn<Param>;
}

/** Throw for an unsupported type anywhere in an array or tuple parameter. */
function assertSupportedParameter(param: AbiParameter): void {
  const arrayMatch = /^(.*)\[[0-9]*\]$/.exec(param.type);
  if (arrayMatch !== null) {
    assertSupportedParameter({
      ...param,
      type: arrayMatch[1]!,
    } as AbiParameter);
    return;
  }
  if (param.type === "tuple") {
    const { components } = param as {
      readonly components: readonly AbiParameter[];
    };
    for (const component of components) assertSupportedParameter(component);
    return;
  }
  abiTypeToPgType(param.type);
}

/** Values for the columns from `abiParametersToColumns`, keyed by column name. */
export function abiParametersToValues(
  params: readonly AbiParameter[],
  values: readonly unknown[] | Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const row: Record<string, unknown> = {};
  for (let index = 0; index < params.length; index++) {
    const param = params[index];
    if (param === undefined) continue;
    assertSupportedParameter(param);
    const name = paramColumnName(param, index);
    const value = Array.isArray(values)
      ? values[index]
      : (values as Readonly<Record<string, unknown>>)[name];
    row[name] = pgValue(param, value);
  }
  return row;
}

function pgValue(param: AbiParameter, value: unknown): unknown {
  const info = abiTypeToPgType(param.type);
  switch (info.pg) {
    case "smallint":
    case "integer":
      return Number(value);
    case "bigint":
    case "numeric(78,0)":
      return BigInt(value as string | number | bigint);
    case "jsonb":
      return jsonValue(param, value);
    default:
      return scalarValue(info, value);
  }
}

/** JSON value with the shape of `AbiParameterToPgJsonType`. */
function jsonValue(param: AbiParameter, value: unknown): unknown {
  const arrayMatch = /^(.*)\[[0-9]*\]$/.exec(param.type);
  if (arrayMatch !== null) {
    const item = { ...param, type: arrayMatch[1]! } as AbiParameter;
    return (value as readonly unknown[]).map((entry) => jsonValue(item, entry));
  }

  if (param.type === "tuple") {
    const { components } = param as {
      readonly components: readonly AbiParameter[];
    };
    const entries = components.map((component, index) =>
      jsonValue(
        component,
        Array.isArray(value)
          ? value[index]
          : (value as Readonly<Record<string, unknown>>)[component.name ?? ""],
      ),
    );
    // abitype gives a tuple as an object only when every component is named.
    if (components.some((component) => !component.name)) return entries;
    return Object.fromEntries(
      components.map((component, index) => [component.name, entries[index]]),
    );
  }

  const info = abiTypeToPgType(param.type);
  const bits = integerBits(param.type);
  if (bits !== undefined) {
    // abitype gives integers of 48 bits or fewer as number, others as bigint.
    return bits <= 48
      ? Number(value)
      : BigInt(value as string | number | bigint).toString();
  }
  return scalarValue(info, value);
}

function scalarValue(info: AbiPgColumnInfo, value: unknown): unknown {
  if (info.hex) return (value as string).toLowerCase();
  if (info.pg === "text") return postgresText(value as string);
  return value;
}

/**
 * Postgres text cannot hold U+0000, and jsonb cannot hold lone surrogates.
 * Both become U+FFFD, as UTF-8 encoding of the calldata does for surrogates.
 */
function postgresText(value: string): string {
  return value.toWellFormed().replaceAll("\u0000", "�");
}

function abiTypeToPgType(abiType: string): AbiPgColumnInfo {
  if (isArrayType(abiType) || abiType.startsWith("tuple")) {
    return { pg: "jsonb" };
  }

  if (abiType === "bool") return { pg: "boolean" };
  if (abiType === "address") return { pg: "char(42)", hex: true };
  if (abiType === "bytes") return { pg: "text", hex: true };
  if (abiType === "string") return { pg: "text" };
  if (abiType === "function") return { pg: "char(50)", hex: true };

  const bytesMatch = /^bytes([1-9]|[12][0-9]|3[0-2])$/.exec(abiType);
  if (bytesMatch !== null) {
    return { pg: `char(${2 + Number(bytesMatch[1]) * 2})`, hex: true };
  }

  const uintMatch = /^uint([0-9]*)$/.exec(abiType);
  if (uintMatch !== null) {
    return { pg: unsignedIntPgType(integerBits(abiType)!) };
  }

  const intMatch = /^int([0-9]*)$/.exec(abiType);
  if (intMatch !== null) {
    return { pg: signedIntPgType(integerBits(abiType)!) };
  }

  throw new Error(`unsupported ABI type: ${abiType}`);
}

function columnForInfo<Param extends AbiParameter>(
  info: AbiPgColumnInfo,
): RuntimeColumnBuilder {
  switch (info.pg) {
    case "boolean":
      return pgBoolean();
    case "smallint":
      return smallint();
    case "integer":
      return integer();
    case "bigint":
      return bigint({ mode: "bigint" });
    case "numeric(78,0)":
      return numeric({ precision: 78, scale: 0, mode: "bigint" });
    case "text":
      return info.hex ? text().$type<Hex>() : text();
    case "jsonb":
      return jsonb().$type<AbiParameterToPgJsonType<Param>>();
    default: {
      const length = charLength(info.pg);
      return info.hex ? char({ length }).$type<Hex>() : char({ length });
    }
  }
}

function paramColumnName(param: AbiParameter, index: number): string {
  if (param.name !== undefined && param.name !== "") return param.name;
  return `arg${index}`;
}

function isArrayType(abiType: string): boolean {
  return /\[[0-9]*\]$/.test(abiType);
}

/** Bit width of an `int` or `uint` type, or `undefined` for other types. */
function integerBits(abiType: string): number | undefined {
  const match = /^u?int([0-9]*)$/.exec(abiType);
  if (match === null) return undefined;
  return match[1] === "" ? 256 : Number(match[1]);
}

function unsignedIntPgType(bits: number): AbiPgType {
  assertIntegerBits(bits, "uint");
  if (bits <= 8) return "smallint";
  if (bits <= 24) return "integer";
  if (bits <= 56) return "bigint";
  return "numeric(78,0)";
}

function signedIntPgType(bits: number): AbiPgType {
  assertIntegerBits(bits, "int");
  if (bits <= 16) return "smallint";
  if (bits <= 32) return "integer";
  if (bits <= 64) return "bigint";
  return "numeric(78,0)";
}

function assertIntegerBits(bits: number, prefix: "int" | "uint"): void {
  if (bits < 8 || bits > 256 || bits % 8 !== 0) {
    throw new Error(`invalid ABI integer type: ${prefix}${bits}`);
  }
}

function charLength(pgType: `char(${number})`): number {
  return Number(pgType.slice("char(".length, -1));
}
