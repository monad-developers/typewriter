import type { AbiParameterToPrimitiveType, AbiType } from "abitype";
import type { Hex } from "ox";
import type { StorageItem, StorageLayout, StorageType } from "./storage-layout";
import type {
  ParsedStoragePathSegment,
  ParseStoragePath,
} from "./storage-path";

/** Raw account storage: 32-byte slot values keyed by slot. */
export type AccountStorage = {
  [slot: Hex.Hex]: Hex.Hex;
};

/** A keccak256 input and its output, as captured during execution. */
export type KeccakPreimage = {
  hash: Hex.Hex;
  preimage: Hex.Hex;
};

/** Names of the top-level state variables in a storage layout. */
export type ExtractVariableNames<layout extends StorageLayout> =
  layout["storage"][number]["label"];

/**
 * Every storage variable selector in a layout: top-level variables, struct
 * fields, array elements, and keyed mapping values.
 *
 * Falls back to `string` when the layout is not a literal type.
 *
 * @example
 * "totalSupply" | "metadata" | "metadata.lastUpdate" | `balances[${Hex}]`
 */
export type StorageVariable<layout extends StorageLayout> =
  IsLooseLayout<layout> extends true
    ? string
    : ItemPaths<layout, layout["storage"][number], "all">;

/**
 * Storage variable selectors that select one concrete value: a value type
 * (integer, address, bool, fixed bytes, or enum), `bytes`, or `string`.
 *
 * Struct roots, array roots, and mappings without every key are excluded.
 * Falls back to `string` when the layout is not a literal type.
 */
export type ConcreteStorageVariable<layout extends StorageLayout> =
  IsLooseLayout<layout> extends true
    ? string
    : ItemPaths<layout, layout["storage"][number], "concrete">;

/**
 * Storage variable selectors that select a mapping, at any depth: top-level
 * mappings, mapping struct fields, and inner mappings of nested mappings.
 *
 * Falls back to `string` when the layout is not a literal type.
 *
 * @example
 * "balances" | "allowances" | `allowances[${Hex}]`
 */
export type MappingStorageVariable<layout extends StorageLayout> =
  IsLooseLayout<layout> extends true
    ? string
    : ItemPaths<layout, layout["storage"][number], "mapping">;

/**
 * Selectors of the entries of a mapping: `mapping[key]` for each key that the
 * mapping's key type accepts.
 *
 * @example
 * MappingEntryVariable<typeof layout, "balances"> // `balances[${Hex}]`
 */
export type MappingEntryVariable<
  layout extends StorageLayout,
  mapping extends string,
> =
  IsLooseLayout<layout> extends true
    ? string
    : StorageTypeAtPath<layout, mapping> extends {
          encoding: "mapping";
          key: infer key extends string;
        }
      ? `${mapping}[${MappingKeySelector<layout, key>}]`
      : never;

/**
 * Storage variable selectors that select a dynamic array, at any depth.
 *
 * Falls back to `string` when the layout is not a literal type.
 *
 * @example
 * "numbers" | `positions[${Hex}].history`
 */
export type DynamicArrayStorageVariable<layout extends StorageLayout> =
  IsLooseLayout<layout> extends true
    ? string
    : ItemPaths<layout, layout["storage"][number], "dynamicArray">;

/**
 * TypeScript type of the value that a storage variable selector selects.
 *
 * Falls back to `unknown` when the layout is not a literal type or the
 * variable is `string`.
 */
export type StorageVariableToPrimitiveType<
  layout extends StorageLayout,
  variable extends string,
> =
  IsLooseLayout<layout> extends true
    ? unknown
    : string extends variable
      ? unknown
      : StorageTypeToPrimitiveType<layout, StorageTypeAtPath<layout, variable>>;

/**
 * TypeScript type of every top-level state variable in a storage layout.
 *
 * Falls back to `Record<string, unknown>` when the layout is not a literal type.
 */
export type StorageLayoutToPrimitiveType<layout extends StorageLayout> =
  IsLooseLayout<layout> extends true
    ? Record<string, unknown>
    : Pretty<{
        [item in layout["storage"][number] as item["label"]]: StorageTypeToPrimitiveType<
          layout,
          StorageTypeById<layout, item["type"]>
        >;
      }>;

// -----------------------------------------------------------------------------
// Internals

type Pretty<type> = { [key in keyof type]: type[key] } & unknown;

type CustomTypeError<message extends string> = [`Error: ${message}`];

/** A layout typed as plain `StorageLayout` rather than a literal. */
type IsLooseLayout<layout extends StorageLayout> =
  string extends ExtractVariableNames<layout> ? true : false;

type StorageTypeById<
  layout extends StorageLayout,
  typeId extends string,
> = typeId extends keyof layout["types"] ? layout["types"][typeId] : never;

// --- Selector extraction -----------------------------------------------------

/** The kind of value a selector selects. */
type SelectorKind =
  | "mapping"
  | "struct"
  | "fixedArray"
  | "dynamicArray"
  | "leaf";

/**
 * Which selectors to extract: every selector except bare mappings (`all`),
 * selectors of one concrete value (`concrete`), or selectors of one kind.
 */
type PathMode = "all" | "concrete" | Exclude<SelectorKind, "leaf">;

type ItemPaths<
  layout extends StorageLayout,
  item extends StorageItem,
  mode extends PathMode,
> = item extends StorageItem
  ? TypePaths<
      layout,
      StorageTypeById<layout, item["type"]>,
      item["label"],
      mode
    >
  : never;

/** Selectors rooted at `prefix` for a value of `type`. */
type TypePaths<
  layout extends StorageLayout,
  type,
  prefix extends string,
  mode extends PathMode,
> = type extends {
  encoding: "mapping";
  key: infer key extends string;
  value: infer value extends string;
}
  ?
      | SelfPath<prefix, mode, "mapping">
      | TypePaths<
          layout,
          StorageTypeById<layout, value>,
          `${prefix}[${MappingKeySelector<layout, key>}]`,
          mode
        >
  : type extends { members: infer members extends readonly StorageItem[] }
    ?
        | SelfPath<prefix, mode, "struct">
        | (members[number] extends infer member extends StorageItem
            ? member extends StorageItem
              ? TypePaths<
                  layout,
                  StorageTypeById<layout, member["type"]>,
                  `${prefix}.${member["label"]}`,
                  mode
                >
              : never
            : never)
    : type extends {
          encoding: "dynamic_array";
          base: infer base extends string;
        }
      ?
          | SelfPath<prefix, mode, "dynamicArray">
          | TypePaths<
              layout,
              StorageTypeById<layout, base>,
              `${prefix}[${number}]`,
              mode
            >
      : type extends {
            base: infer base extends string;
            label: infer label extends string;
          }
        ?
            | SelfPath<prefix, mode, "fixedArray">
            | TypePaths<
                layout,
                StorageTypeById<layout, base>,
                `${prefix}[${FixedArrayIndex<FixedArrayLength<label>>}]`,
                mode
              >
        : SelfPath<prefix, mode, "leaf">;

/**
 * Whether a selector of this `kind` is included in `mode`. A bare mapping is
 * only a `mapping` selector: without a key it does not select a value.
 */
type SelfPath<
  prefix extends string,
  mode extends PathMode,
  kind extends SelectorKind,
> = mode extends "all"
  ? kind extends "mapping"
    ? never
    : prefix
  : mode extends "concrete"
    ? kind extends "leaf"
      ? prefix
      : never
    : kind extends mode
      ? prefix
      : never;

/** Selector text accepted between `[` and `]` for a mapping key type. */
type MappingKeySelector<
  layout extends StorageLayout,
  keyTypeId extends string,
> =
  StorageTypeById<layout, keyTypeId> extends {
    label: infer label extends string;
  }
    ? label extends "address" | `bytes${number}`
      ? Hex.Hex
      : label extends "bool"
        ? "true" | "false"
        : label extends `uint${string}` | `int${string}`
          ? `${number}`
          : never
    : never;

/** Union of valid indexes `0 | 1 | ... | length - 1`. */
type FixedArrayIndex<
  length extends number,
  acc extends readonly unknown[] = [],
> = [length] extends [never]
  ? never
  : number extends length
    ? number
    : acc["length"] extends length
      ? never
      : acc["length"] | FixedArrayIndex<length, readonly [...acc, unknown]>;

/** Outermost length of a fixed array label, e.g. `3` for `uint128[2][3]`. */
type FixedArrayLength<label extends string> =
  label extends `${string}[${infer rest}`
    ? rest extends `${infer current}]${infer tail}`
      ? tail extends ""
        ? current extends `${infer length extends number}`
          ? length
          : never
        : FixedArrayLength<tail>
      : never
    : never;

// --- Selector -> storage type ------------------------------------------------

type StorageTypeAtPath<
  layout extends StorageLayout,
  variable extends string,
> = variable extends string
  ? ParseStoragePath<variable> extends {
      root: infer root;
      segments: infer segments extends readonly ParsedStoragePathSegment[];
    }
    ? root extends ExtractVariableNames<layout>
      ? StorageTypeAtSegments<
          layout,
          StorageTypeById<
            layout,
            Extract<layout["storage"][number], { label: root }>["type"]
          >,
          segments
        >
      : CustomTypeError<"Storage variable was not found in storage layout.">
    : never
  : never;

type StorageTypeAtSegments<
  layout extends StorageLayout,
  type,
  segments extends readonly ParsedStoragePathSegment[],
> = segments extends readonly [
  infer segment extends ParsedStoragePathSegment,
  ...infer rest extends readonly ParsedStoragePathSegment[],
]
  ? StorageTypeAtSegments<
      layout,
      StorageTypeAtSegment<layout, type, segment>,
      rest
    >
  : type;

type StorageTypeAtSegment<
  layout extends StorageLayout,
  type,
  segment extends ParsedStoragePathSegment,
> =
  type extends CustomTypeError<string>
    ? type
    : segment extends { kind: "field"; name: infer name extends string }
      ? type extends { members: infer members extends readonly StorageItem[] }
        ? [Extract<members[number], { label: name }>] extends [never]
          ? CustomTypeError<"Storage path field was not found in struct.">
          : StorageTypeById<
              layout,
              Extract<members[number], { label: name }>["type"]
            >
        : CustomTypeError<"Storage path field requires a struct.">
      : type extends { encoding: "mapping"; value: infer value extends string }
        ? StorageTypeById<layout, value>
        : type extends { base: infer base extends string }
          ? StorageTypeById<layout, base>
          : CustomTypeError<"Storage path subscript requires an array or mapping.">;

// --- Storage type -> TypeScript type -----------------------------------------

type StorageTypeToPrimitiveType<
  layout extends StorageLayout,
  type,
> = type extends StorageType
  ? type extends {
      encoding: "mapping";
      key: infer key extends string;
      value: infer value extends string;
    }
    ? [MappingKeySelector<layout, key>] extends [never]
      ? CustomTypeError<`Unsupported mapping key type '${StorageTypeById<layout, key>["label"]}'.`>
      : Record<
          MappingKeySelector<layout, key>,
          StorageTypeToPrimitiveType<layout, StorageTypeById<layout, value>>
        >
    : type extends { members: infer members extends readonly StorageItem[] }
      ? Pretty<{
          [member in members[number] as member["label"]]: StorageTypeToPrimitiveType<
            layout,
            StorageTypeById<layout, member["type"]>
          >;
        }>
      : type extends {
            encoding: "dynamic_array";
            base: infer base extends string;
          }
        ? readonly StorageTypeToPrimitiveType<
            layout,
            StorageTypeById<layout, base>
          >[]
        : type extends {
              base: infer base extends string;
              label: infer label extends string;
            }
          ? FixedArray<
              StorageTypeToPrimitiveType<layout, StorageTypeById<layout, base>>,
              FixedArrayLength<label>
            >
          : LabelToPrimitiveType<type["label"]>
  : // Pass a `CustomTypeError` from path resolution through unchanged.
    type;

type LabelToPrimitiveType<label extends string> = label extends `enum ${string}`
  ? number
  : label extends AbiType
    ? AbiParameterToPrimitiveType<{ type: label }>
    : CustomTypeError<`Unsupported type '${label}'.`>;

type FixedArray<
  element,
  length extends number,
  acc extends readonly element[] = [],
> = [length] extends [never]
  ? CustomTypeError<"Fixed array type is missing its length.">
  : acc["length"] extends length
    ? acc
    : FixedArray<element, length, readonly [...acc, element]>;
