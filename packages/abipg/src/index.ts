import type { AbiParameter, AbiParameterToPrimitiveType } from "abitype";
import {
  type AnyPgColumnBuilder,
  bigint,
  char,
  integer,
  jsonb,
  numeric,
  type PgBigInt64Builder,
  type PgBooleanBuilder,
  type PgCharBuilder,
  type PgIntegerBuilder,
  type PgJsonbBuilder,
  type PgNumericBuilder,
  type PgSmallIntBuilder,
  type PgTextBuilder,
  boolean as pgBoolean,
  smallint,
  text,
} from "drizzle-orm/pg-core";

type AbiPgType =
  | "boolean"
  | "smallint"
  | "integer"
  | "bigint"
  | "numeric(78,0)"
  | `char(${number})`
  | "char(2 + 2N)"
  | "text"
  | "jsonb";

type NotNullBuilder<Builder> = Builder extends { notNull(): infer Result }
  ? Result
  : never;

type RuntimeColumnBuilder = AnyPgColumnBuilder & {
  notNull(): AnyPgColumnBuilder;
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

type JsonbBuilderFor<T> = PgJsonbBuilder & {
  readonly _: PgJsonbBuilder["_"] & { readonly $type: T };
};

export type AbiParameterToColumn<Param extends AbiParameter> =
  Param["type"] extends `${string}[${string}]` | `tuple${string}`
    ? NotNullBuilder<JsonbBuilderFor<AbiParameterToPgJsonType<Param>>>
    : Param["type"] extends "bool"
      ? NotNullBuilder<PgBooleanBuilder>
      : Param["type"] extends "uint8" | "int8" | "int16"
        ? NotNullBuilder<PgSmallIntBuilder>
        : Param["type"] extends "uint16" | "uint24" | "int24" | "int32"
          ? NotNullBuilder<PgIntegerBuilder>
          : Param["type"] extends
                | "uint32"
                | "uint40"
                | "uint48"
                | "uint56"
                | "int40"
                | "int48"
                | "int56"
                | "int64"
            ? NotNullBuilder<PgBigInt64Builder>
            : Param["type"] extends `uint${string}` | `int${string}`
              ? NotNullBuilder<PgNumericBuilder>
              : Param["type"] extends "string" | "bytes"
                ? NotNullBuilder<PgTextBuilder>
                : Param["type"] extends
                      | "address"
                      | `bytes${string}`
                      | "function"
                  ? NotNullBuilder<PgCharBuilder>
                  : NotNullBuilder<
                      JsonbBuilderFor<AbiParameterToPgJsonType<Param>>
                    >;

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
  readonly complex: boolean;
};

export function abiParametersToColumns<
  const Params extends readonly AbiParameter[],
>(
  params: Params,
  options: { readonly notNull?: boolean } = {},
): AbiParametersToColumns<Params> {
  const columns: Record<string, AnyPgColumnBuilder> = {};
  for (let index = 0; index < params.length; index++) {
    const param = params[index];
    if (param === undefined) continue;
    const name = paramColumnName(param, index);
    if (columns[name] !== undefined) {
      throw new Error(`duplicate ABI parameter column name: ${name}`);
    }
    columns[name] = abiParameterToColumn(param, options);
  }
  return columns as AbiParametersToColumns<Params>;
}

export function abiParameterToColumn<const Param extends AbiParameter>(
  param: Param,
  options: { readonly notNull?: boolean } = {},
): AbiParameterToColumn<Param> {
  const column = columnForInfo<Param>(abiTypeToPgType(param.type));
  return (
    options.notNull === false ? column : column.notNull()
  ) as AbiParameterToColumn<Param>;
}

function abiTypeToPgType(abiType: string): AbiPgColumnInfo {
  if (isArrayType(abiType) || abiType.startsWith("tuple")) {
    return { pg: "jsonb", complex: true };
  }

  if (abiType === "bool") return { pg: "boolean", complex: false };
  if (abiType === "address") return { pg: "char(42)", complex: false };
  if (abiType === "bytes") return { pg: "text", complex: false };
  if (abiType === "string") return { pg: "text", complex: false };
  if (abiType === "function") return { pg: "char(50)", complex: false };

  const bytesMatch = /^bytes([1-9]|[12][0-9]|3[0-2])$/.exec(abiType);
  if (bytesMatch !== null) {
    return {
      pg: `char(${2 + Number(bytesMatch[1]) * 2})`,
      complex: false,
    };
  }

  if (abiType === "uint") return { pg: "numeric(78,0)", complex: false };
  if (abiType === "int") return { pg: "numeric(78,0)", complex: false };

  const uintMatch = /^uint([0-9]+)$/.exec(abiType);
  if (uintMatch !== null) {
    return { pg: unsignedIntPgType(Number(uintMatch[1])), complex: false };
  }

  const intMatch = /^int([0-9]+)$/.exec(abiType);
  if (intMatch !== null) {
    return { pg: signedIntPgType(Number(intMatch[1])), complex: false };
  }

  if (/^u?fixed([0-9]+)x([0-9]+)$/.test(abiType)) {
    return { pg: "numeric(78,0)", complex: false };
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
      return numeric({ precision: 78, scale: 0 });
    case "text":
      return text();
    case "jsonb":
      return jsonb().$type<AbiParameterToPgJsonType<Param>>();
    default: {
      if (info.pg === "char(2 + 2N)") {
        throw new Error("dynamic mapping placeholder cannot build a column");
      }
      const length = charLength(info.pg);
      return char({ length });
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
