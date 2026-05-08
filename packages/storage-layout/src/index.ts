import type { AbiParameterToPrimitiveType, AbiType } from "abitype";
import { Hex } from "ox";

/** Hex string with `0x` prefix. */
export type HexString = Hex.Hex;

/**
 * Storage item as defined in the JSON output of the Solidity compiler.
 *
 * @see https://docs.soliditylang.org/en/latest/internals/layout_in_storage.html#json-output
 */
export type StorageItem = {
  /** ID of the AST node of the state variable's declaration. */
  astId: number;
  /** Name of the contract including its path as prefix. */
  contract: `${string}:${string}`;
  /** Name of the state variable. */
  label: string;
  /** Offset in bytes within the storage slot according to the encoding. */
  offset: number;
  /** Storage slot where the state variable resides or starts. */
  slot: `${number}`;
  /** Identifier used as key to the variable's type information. */
  type: string;
};

/**
 * Storage type as defined in the JSON output of the Solidity compiler.
 *
 * @see https://docs.soliditylang.org/en/latest/internals/layout_in_storage.html#json-output
 */
export type StorageType = {
  /** How the data is encoded in storage. */
  encoding: "inplace" | "dynamic_array" | "bytes" | "mapping";
  /** Canonical type name. */
  label: string;
  /** Number of used bytes. If greater than 32, the value spans multiple slots. */
  numberOfBytes: `${number}`;
  /** Members for struct types. */
  members?: readonly StorageItem[];
  /** Base type for array types. */
  base?: string;
  /** Key type for mapping types. */
  key?: string;
  /** Value type for mapping types. */
  value?: string;
};

/**
 * Storage layout as defined in the JSON output of the Solidity compiler.
 *
 * @see https://docs.soliditylang.org/en/latest/internals/layout_in_storage.html#json-output
 */
export type StorageLayout = {
  storage: readonly StorageItem[];
  types: Record<string, StorageType>;
};

/**
 * Structured representation of a Solidity storage variable or sub-value.
 *
 * @example
 * // totalSupply
 * { root: "totalSupply", segments: [] }
 *
 * @example
 * // accounts[0xabcd].orders[3].price
 * {
 *   root: "accounts",
 *   segments: [
 *     { kind: "subscript", value: { kind: "hex", value: "0xabcd" } },
 *     { kind: "field", name: "orders" },
 *     { kind: "subscript", value: { kind: "number", value: 3n } },
 *     { kind: "field", name: "price" },
 *   ],
 * }
 */
export type StoragePath = {
  root: string;
  segments: readonly StoragePathSegment[];
};

/** One step after the root variable in a `StoragePath`. */
export type StoragePathSegment =
  | { kind: "field"; name: string }
  | { kind: "subscript"; value: StoragePathSubscript };

/** Human-entered bracket selector. Resolution decides whether this is an array index or mapping key. */
export type StoragePathSubscript =
  | { kind: "number"; value: bigint }
  | { kind: "hex"; value: HexString }
  | { kind: "string"; value: string }
  | { kind: "bool"; value: boolean };

/** Concrete slot location for a resolved `StoragePath`. */
export type StorageSlot = {
  path: StoragePath;
  slot: HexString;
  offset: number;
  numberOfBytes: number;
  type: string;
};

export type StorageSlotChange =
  | HexString
  | { slot: HexString; value?: HexString };

export type StorageVariableUpdate = StorageSlot & {
  value?: HexString;
};

export type SlotWrite = {
  slot: HexString;
  value: HexString;
};

/**
 * Key-value map of storage slots to their hex values.
 */
export type AccountStorage = {
  [slot: HexString]: HexString;
};

export type Pretty<T> = { [K in keyof T]: T[K] } & unknown;

export type CustomTypeError<Message extends string> = [`Error: ${Message}`];

export type ExtractVariableNames<Layout extends StorageLayout> =
  Layout["storage"][number]["label"];

export type StorageLayoutToVariableTypes<Layout extends StorageLayout> =
  Pretty<{
    [Name in ExtractVariableNames<Layout>]: StorageLayoutToVariableType<
      Layout,
      Name
    >;
  }>;

export type StorageLayoutToVariableType<
  Layout extends StorageLayout,
  Name extends ExtractVariableNames<Layout>,
> = StorageTypeToPrimitiveType<
  StorageTypeForItem<
    Layout,
    Extract<Layout["storage"][number], { label: Name }>
  >,
  Layout
>;

export type StaticStoragePath<Layout extends StorageLayout> = {
  [Name in ExtractVariableNames<Layout>]: {
    root: Name;
    segments: readonly [];
  };
}[ExtractVariableNames<Layout>];

export type StoragePathToPrimitiveType<
  Layout extends StorageLayout,
  Path extends string | StoragePath,
> = Path extends string
  ? StoragePathStringToPrimitiveType<Layout, Path>
  : Path extends {
        root: infer Root extends ExtractVariableNames<Layout>;
        segments: infer Segments;
      }
    ? Segments extends readonly []
      ? StorageLayoutToVariableType<Layout, Root>
      : CustomTypeError<"Nested StoragePath typing is not implemented yet.">
    : CustomTypeError<"StoragePath root was not found in storage layout.">;

export type ExtractMappingVariableNames<Layout extends StorageLayout> = Extract<
  Layout["storage"][number],
  { type: MappingTypeIds<Layout> }
>["label"];

export type ExtractMappingType<
  Layout extends StorageLayout,
  Name extends ExtractMappingVariableNames<Layout>,
  KeyOrValue extends "key" | "value",
> = StorageTypeToPrimitiveType<
  StorageTypeForId<
    Layout,
    Extract<
      StorageTypeForItem<
        Layout,
        Extract<Layout["storage"][number], { label: Name }>
      >[KeyOrValue],
      string
    >
  >,
  Layout
>;

export type IsVariableSingleSlot<
  Layout extends StorageLayout,
  Name extends ExtractVariableNames<Layout>,
> = IsStorageTypeSingleSlot<
  StorageTypeForItem<
    Layout,
    Extract<Layout["storage"][number], { label: Name }>
  >
>;

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;
const DECIMAL = /^(0|[1-9][0-9]*)$/;
const HEX = /^0x[0-9a-fA-F]*$/;

/**
 * Parse a human-readable Solidity storage path into structured form.
 *
 * @example
 * parseStoragePath("metadata.lastUpdate")
 * parseStoragePath("balances[0x1234]")
 */
export function parseStoragePath(input: string): StoragePath {
  if (input.length === 0) {
    throw new Error("storage path cannot be empty");
  }

  let index = 0;
  const root = readIdentifier(input, index);
  index = root.next;
  const segments: StoragePathSegment[] = [];

  while (index < input.length) {
    const char = input[index];
    if (char === ".") {
      const field = readIdentifier(input, index + 1);
      segments.push({ kind: "field", name: field.value });
      index = field.next;
      continue;
    }
    if (char === "[") {
      const end = input.indexOf("]", index + 1);
      if (end === -1) {
        throw new Error(`unterminated subscript in storage path: ${input}`);
      }
      const raw = input.slice(index + 1, end).trim();
      segments.push({ kind: "subscript", value: parseSubscript(raw) });
      index = end + 1;
      continue;
    }
    throw new Error(`unexpected '${char}' in storage path: ${input}`);
  }

  return { root: root.value, segments };
}

/**
 * Format a structured storage path as a human-readable string.
 */
export function formatStoragePath(path: StoragePath): string {
  let out = path.root;
  for (const segment of path.segments) {
    if (segment.kind === "field") {
      out += `.${segment.name}`;
    } else {
      out += `[${formatSubscript(segment.value)}]`;
    }
  }
  return out;
}

/**
 * Compute storage slots for a concrete Solidity storage path.
 *
 * @param layout - Solidity compiler `storageLayout` output.
 * @param pathInput - Human-readable or structured storage path.
 *
 * @dev The initial implementation supports top-level value types only.
 */
export function getStorageSlot(
  layout: StorageLayout,
  pathInput: string | StoragePath,
): StorageSlot[] {
  const path = normalizePath(pathInput);
  if (path.segments.length > 0) {
    throw new Error(
      `nested storage paths are not supported yet: ${formatStoragePath(path)}`,
    );
  }

  const item = findStorageItem(layout, path.root);
  const type = findStorageType(layout, item.type);
  assertValueType(type, path);

  return [
    {
      path,
      slot: slotFromDecimal(item.slot),
      offset: item.offset,
      numberOfBytes: Number(type.numberOfBytes),
      type: type.label,
    },
  ];
}

/**
 * Match raw storage slot changes back to known Solidity storage paths.
 *
 * @param layout - Solidity compiler `storageLayout` output.
 * @param changes - Changed slots, optionally with new values.
 * @param knownPaths - Universe of paths that may be matched. Static top-level value paths are generated by default.
 *
 * @dev Mappings are not reversible from a raw slot alone. Pass known keyed paths once mapping support is implemented.
 */
export function getStoragePath(
  layout: StorageLayout,
  changes: readonly StorageSlotChange[],
  options: { knownPaths?: readonly (string | StoragePath)[] } = {},
): StoragePath[] {
  const knownPaths = options.knownPaths ?? getStaticStoragePaths(layout);
  const matches: StoragePath[] = [];
  const seen = new Set<string>();

  for (const change of changes) {
    const slot = normalizeSlot(
      typeof change === "string" ? change : change.slot,
    );
    for (const knownPath of knownPaths) {
      const knownSlots = getStorageSlot(layout, knownPath);
      if (
        knownSlots.some(
          (known) => known.slot.toLowerCase() === slot.toLowerCase(),
        )
      ) {
        const path = normalizePath(knownPath);
        const key = formatStoragePath(path);
        if (!seen.has(key)) {
          seen.add(key);
          matches.push(path);
        }
      }
    }
  }

  return matches;
}

/**
 * Decode a Solidity storage path value from raw slot values.
 *
 * @param layout - Solidity compiler `storageLayout` output.
 * @param path - Human-readable or structured storage path.
 * @param storage - Raw account storage keyed by slot.
 *
 * @dev The initial implementation supports top-level value types only.
 */
export function decodeStorage<
  Layout extends StorageLayout,
  Path extends string | StoragePath,
>(
  layout: Layout,
  path: Path,
  storage: AccountStorage,
): StoragePathToPrimitiveType<Layout, Path> {
  const [slot] = getStorageSlot(layout, path);
  if (slot === undefined) {
    throw new Error(
      `storage path did not resolve to a slot: ${pathToString(path)}`,
    );
  }
  const value = getSlotValue(storage, slot.slot);
  if (value === undefined) {
    throw new Error(`storage value not found for slot: ${slot.slot}`);
  }
  return decodeValue(slot, value) as StoragePathToPrimitiveType<Layout, Path>;
}

/**
 * Encode a Solidity storage path value into raw slot writes.
 *
 * @param layout - Solidity compiler `storageLayout` output.
 * @param path - Human-readable or structured storage path.
 * @param value - JavaScript value to encode.
 * @param storage - Existing raw account storage. Required for packed values so neighboring bytes are preserved.
 *
 * @dev The initial implementation supports top-level value types only.
 */
export function encodeStorage<
  Layout extends StorageLayout,
  Path extends string | StoragePath,
>(
  layout: Layout,
  path: Path,
  value: StoragePathToPrimitiveType<Layout, Path>,
  storage: AccountStorage = {},
): SlotWrite[] {
  const [slot] = getStorageSlot(layout, path);
  if (slot === undefined) {
    throw new Error(
      `storage path did not resolve to a slot: ${pathToString(path)}`,
    );
  }
  const existing = getSlotValue(storage, slot.slot);
  if (isPartialSlot(slot) && existing === undefined) {
    throw new Error(
      `existing storage value is required to encode packed path: ${formatStoragePath(slot.path)}`,
    );
  }
  return [
    {
      slot: slot.slot,
      value: encodeValue(slot, value, existing),
    },
  ];
}

/**
 * Enumerate finite static paths that can be known from `storageLayout` alone.
 *
 * @dev Mapping paths and nested dynamic paths require known keys or indices.
 */
export function getStaticStoragePaths(layout: StorageLayout): StoragePath[] {
  const paths: StoragePath[] = [];
  for (const item of layout.storage) {
    const type = findStorageType(layout, item.type);
    if (isValueType(type)) {
      paths.push({ root: item.label, segments: [] });
    }
  }
  return paths;
}

function normalizePath(path: string | StoragePath): StoragePath {
  return typeof path === "string" ? parseStoragePath(path) : path;
}

function readIdentifier(
  input: string,
  start: number,
): { value: string; next: number } {
  let next = start;
  while (next < input.length) {
    const char = input[next]!;
    if (!/[A-Za-z0-9_]/.test(char)) break;
    next++;
  }
  const value = input.slice(start, next);
  if (!IDENTIFIER.test(value)) {
    throw new Error(`expected identifier in storage path: ${input}`);
  }
  return { value, next };
}

function parseSubscript(raw: string): StoragePathSubscript {
  if (raw.length === 0) {
    throw new Error("storage path subscript cannot be empty");
  }
  if (HEX.test(raw)) {
    return { kind: "hex", value: raw as HexString };
  }
  if (DECIMAL.test(raw)) {
    return { kind: "number", value: BigInt(raw) };
  }
  if (raw === "true" || raw === "false") {
    return { kind: "bool", value: raw === "true" };
  }
  if (
    (raw.startsWith('"') && raw.endsWith('"')) ||
    (raw.startsWith("'") && raw.endsWith("'"))
  ) {
    return { kind: "string", value: raw.slice(1, -1) };
  }
  throw new Error(`unsupported storage path subscript: ${raw}`);
}

function formatSubscript(subscript: StoragePathSubscript): string {
  switch (subscript.kind) {
    case "number":
      return subscript.value.toString();
    case "hex":
      return subscript.value;
    case "string":
      return JSON.stringify(subscript.value);
    case "bool":
      return String(subscript.value);
  }
}

function findStorageItem(layout: StorageLayout, label: string): StorageItem {
  const item = layout.storage.find((candidate) => candidate.label === label);
  if (item === undefined) {
    throw new Error(`storage variable not found: ${label}`);
  }
  return item;
}

function findStorageType(layout: StorageLayout, typeId: string): StorageType {
  const type = layout.types[typeId];
  if (type === undefined) {
    throw new Error(`storage type not found: ${typeId}`);
  }
  return type;
}

function assertValueType(type: StorageType, path: StoragePath): void {
  if (!isValueType(type)) {
    throw new Error(
      `unsupported storage path type '${type.label}' for ${formatStoragePath(path)}`,
    );
  }
}

function isValueType(type: StorageType): boolean {
  if (type.encoding !== "inplace" || type.members !== undefined) {
    return false;
  }
  return (
    /^u?int[0-9]*$/.test(type.label) ||
    type.label === "address" ||
    type.label === "bool" ||
    /^bytes([1-9]|[12][0-9]|3[0-2])$/.test(type.label) ||
    type.label.startsWith("enum ")
  );
}

function slotFromDecimal(slot: `${number}`): HexString {
  return Hex.fromNumber(BigInt(slot), { size: 32 });
}

function normalizeSlot(slot: HexString): HexString {
  return Hex.fromNumber(BigInt(slot), { size: 32 });
}

function normalizeSlotValue(value: HexString): HexString {
  return Hex.fromNumber(BigInt(value), { size: 32 });
}

function pathToString(path: string | StoragePath): string {
  return typeof path === "string" ? path : formatStoragePath(path);
}

function getSlotValue(
  storage: AccountStorage,
  requestedSlot: HexString,
): HexString | undefined {
  const normalized = normalizeSlot(requestedSlot);
  const direct = storage[normalized];
  if (direct !== undefined) {
    return normalizeSlotValue(direct);
  }

  for (const [slot, value] of Object.entries(storage)) {
    if (
      normalizeSlot(slot as HexString).toLowerCase() ===
      normalized.toLowerCase()
    ) {
      return normalizeSlotValue(value as HexString);
    }
  }
  return undefined;
}

function isPartialSlot(slot: StorageSlot): boolean {
  return slot.offset !== 0 || slot.numberOfBytes !== 32;
}

function decodeValue(slot: StorageSlot, slotValue: HexString): unknown {
  const value = extractField(
    BigInt(slotValue),
    slot.offset,
    slot.numberOfBytes,
  );
  const info = parseValueType(slot.type, slot.numberOfBytes);
  switch (info.kind) {
    case "uint":
      return integerResult(value, slot.numberOfBytes);
    case "int":
      return integerResult(decodeSigned(value, info.bits), slot.numberOfBytes);
    case "address":
      return Hex.fromNumber(value, { size: 20 });
    case "bool":
      return value !== 0n;
    case "bytes":
      return Hex.fromNumber(value, { size: slot.numberOfBytes });
    case "enum":
      return Number(value);
  }
}

function encodeValue(
  slot: StorageSlot,
  value: unknown,
  existingSlotValue: HexString | undefined,
): HexString {
  const info = parseValueType(slot.type, slot.numberOfBytes);
  const encoded = encodeField(info, slot.numberOfBytes, value);
  const base = existingSlotValue === undefined ? 0n : BigInt(existingSlotValue);
  const shift = BigInt(slot.offset * 8);
  const mask = fieldMask(slot.numberOfBytes) << shift;
  const next = (base & ~mask) | (encoded << shift);
  return Hex.fromNumber(next, { size: 32 });
}

function extractField(
  slotValue: bigint,
  offset: number,
  numberOfBytes: number,
): bigint {
  return (slotValue >> BigInt(offset * 8)) & fieldMask(numberOfBytes);
}

function fieldMask(numberOfBytes: number): bigint {
  return (1n << BigInt(numberOfBytes * 8)) - 1n;
}

function integerResult(value: bigint, numberOfBytes: number): bigint | number {
  // Match abitype's default primitive mapping: <= 48-bit ints are numbers.
  if (numberOfBytes <= 6) {
    return Number(value);
  }
  return value;
}

function decodeSigned(value: bigint, bits: number): bigint {
  const signBit = 1n << BigInt(bits - 1);
  if ((value & signBit) === 0n) {
    return value;
  }
  return value - (1n << BigInt(bits));
}

type ParsedValueType =
  | { kind: "uint"; bits: number }
  | { kind: "int"; bits: number }
  | { kind: "address"; bits: 160 }
  | { kind: "bool"; bits: 8 }
  | { kind: "bytes"; bytes: number }
  | { kind: "enum"; bytes: number };

function parseValueType(type: string, numberOfBytes: number): ParsedValueType {
  if (type === "uint") {
    return { kind: "uint", bits: 256 };
  }
  if (type === "int") {
    return { kind: "int", bits: 256 };
  }
  if (type.startsWith("uint")) {
    return { kind: "uint", bits: parseIntegerBits(type, "uint") };
  }
  if (type.startsWith("int")) {
    return { kind: "int", bits: parseIntegerBits(type, "int") };
  }
  if (type === "address") {
    return { kind: "address", bits: 160 };
  }
  if (type === "bool") {
    return { kind: "bool", bits: 8 };
  }
  if (/^bytes([1-9]|[12][0-9]|3[0-2])$/.test(type)) {
    return { kind: "bytes", bytes: Number(type.slice("bytes".length)) };
  }
  if (type.startsWith("enum ")) {
    return { kind: "enum", bytes: numberOfBytes };
  }
  throw new Error(`unsupported value type: ${type}`);
}

function parseIntegerBits(type: string, prefix: "uint" | "int"): number {
  const suffix = type.slice(prefix.length);
  const bits = suffix === "" ? 256 : Number(suffix);
  if (!Number.isInteger(bits) || bits < 8 || bits > 256 || bits % 8 !== 0) {
    throw new Error(`invalid Solidity integer type: ${type}`);
  }
  return bits;
}

function encodeField(
  type: ParsedValueType,
  numberOfBytes: number,
  value: unknown,
): bigint {
  switch (type.kind) {
    case "uint":
      return encodeUnsigned(toBigInt(value, "uint"), type.bits);
    case "int":
      return encodeSigned(toBigInt(value, "int"), type.bits);
    case "address":
      if (typeof value !== "string" || !HEX.test(value)) {
        throw new Error("address value must be a hex string");
      }
      return encodeUnsigned(BigInt(value), type.bits);
    case "bool":
      if (typeof value !== "boolean") {
        throw new Error("bool value must be a boolean");
      }
      return value ? 1n : 0n;
    case "bytes":
      return encodeFixedBytes(value, type.bytes);
    case "enum":
      return encodeUnsigned(toBigInt(value, "enum"), numberOfBytes * 8);
  }
}

function toBigInt(value: unknown, label: string): bigint {
  if (typeof value === "bigint") {
    return value;
  }
  if (typeof value === "number" && Number.isInteger(value)) {
    return BigInt(value);
  }
  throw new Error(`${label} value must be an integer`);
}

function encodeUnsigned(value: bigint, bits: number): bigint {
  const max = 1n << BigInt(bits);
  if (value < 0n || value >= max) {
    throw new Error(`unsigned integer does not fit in ${bits} bits`);
  }
  return value;
}

function encodeSigned(value: bigint, bits: number): bigint {
  const min = -(1n << BigInt(bits - 1));
  const max = (1n << BigInt(bits - 1)) - 1n;
  if (value < min || value > max) {
    throw new Error(`signed integer does not fit in ${bits} bits`);
  }
  if (value >= 0n) {
    return value;
  }
  return (1n << BigInt(bits)) + value;
}

function encodeFixedBytes(value: unknown, numberOfBytes: number): bigint {
  if (typeof value !== "string" || !HEX.test(value)) {
    throw new Error("fixed bytes value must be a hex string");
  }
  const actualBytes = (value.length - 2) / 2;
  if (!Number.isInteger(actualBytes) || actualBytes !== numberOfBytes) {
    throw new Error(`fixed bytes value must be exactly ${numberOfBytes} bytes`);
  }
  return BigInt(value);
}

type StoragePathStringToPrimitiveType<
  Layout extends StorageLayout,
  Path extends string,
> = Path extends `${string}.${string}` | `${string}[${string}]${string}`
  ? CustomTypeError<"Nested storage path string typing is not implemented yet.">
  : Path extends ExtractVariableNames<Layout>
    ? StorageLayoutToVariableType<Layout, Path>
    : CustomTypeError<"Storage path root was not found in storage layout.">;

type StorageTypeForItem<
  Layout extends StorageLayout,
  Item extends StorageItem,
> = StorageTypeForId<Layout, Item["type"]>;

type StorageTypeForId<
  Layout extends StorageLayout,
  TypeId extends string,
> = TypeId extends keyof Layout["types"] ? Layout["types"][TypeId] : never;

type StorageTypeToPrimitiveType<
  Type extends StorageType,
  Layout extends StorageLayout,
> = Type["encoding"] extends "mapping"
  ? CustomTypeError<`Unsupported type '${Type["label"]}'.`>
  : Type extends { members: readonly StorageItem[] }
    ? Pretty<StorageMembersToObject<Layout, Type["members"]>>
    : Type["label"] extends `enum ${string}`
      ? number
      : Type["label"] extends AbiType
        ? AbiParameterToPrimitiveType<{ type: Type["label"] }>
        : Type["encoding"] extends "dynamic_array"
          ? Type extends { base: infer Base extends string }
            ? readonly StorageTypeToPrimitiveType<
                StorageTypeForId<Layout, Base>,
                Layout
              >[]
            : CustomTypeError<`Array type '${Type["label"]}' is missing base type.`>
          : Type extends { base: infer Base extends string }
            ? Type["label"] extends `${string}[${infer Length extends number}]`
              ? FixedArray<
                  StorageTypeToPrimitiveType<
                    StorageTypeForId<Layout, Base>,
                    Layout
                  >,
                  Length
                >
              : SolidityLabelToPrimitiveType<Type["label"]>
            : Type["label"] extends `${infer Element}[${infer Length extends number}]`
              ? FixedArray<SolidityLabelToPrimitiveType<Element>, Length>
              : SolidityLabelToPrimitiveType<Type["label"]>;

type StorageMembersToObject<
  Layout extends StorageLayout,
  Members extends readonly StorageItem[],
> = {
  [Member in Members[number] as Member["label"]]: StorageTypeToPrimitiveType<
    StorageTypeForItem<Layout, Member>,
    Layout
  >;
};

type SolidityLabelToPrimitiveType<Label extends string> = Label extends AbiType
  ? AbiParameterToPrimitiveType<{ type: Label }>
  : Label extends `enum ${string}`
    ? number
    : CustomTypeError<`Unsupported type '${Label}'.`>;

type MappingTypeIds<Layout extends StorageLayout> = {
  [TypeId in keyof Layout["types"]]: Layout["types"][TypeId]["encoding"] extends "mapping"
    ? TypeId
    : never;
}[keyof Layout["types"]];

type IsStorageTypeSingleSlot<Type extends StorageType> =
  Type["numberOfBytes"] extends SingleSlotByteCount ? true : false;

type SingleSlotByteCount =
  | "1"
  | "2"
  | "3"
  | "4"
  | "5"
  | "6"
  | "7"
  | "8"
  | "9"
  | "10"
  | "11"
  | "12"
  | "13"
  | "14"
  | "15"
  | "16"
  | "17"
  | "18"
  | "19"
  | "20"
  | "21"
  | "22"
  | "23"
  | "24"
  | "25"
  | "26"
  | "27"
  | "28"
  | "29"
  | "30"
  | "31"
  | "32";

type FixedArray<
  Element,
  Length extends number,
  Acc extends readonly Element[] = [],
> = Acc["length"] extends Length
  ? Acc
  : FixedArray<Element, Length, readonly [...Acc, Element]>;
