import { Hash, Hex } from "ox";
import {
  type ResolvedStorageItem,
  resolveStoragePath,
  type StorageLayout,
  type StoragePathToPrimitiveType,
} from "./storage-layout";
import type {
  AccountStorage,
  ConcreteStoragePath,
  SlotWrite,
  SlotWrites,
} from "./types";

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
  | { kind: "hex"; value: Hex.Hex }
  | { kind: "string"; value: string }
  | { kind: "bool"; value: boolean };

export type ParsedStoragePath = {
  root: string;
  segments: readonly ParsedStoragePathSegment[];
};

export type ParsedStoragePathSegment =
  | { kind: "field"; name: string }
  | { kind: "subscript" };

export type ParseStoragePath<Path extends string> =
  Path extends `${infer Head}.${infer Tail}`
    ? ParseStoragePathRoot<Head> extends infer Parsed extends ParsedStoragePath
      ? {
          root: Parsed["root"];
          segments: readonly [
            ...Parsed["segments"],
            ...ParseStoragePathTail<Tail>,
          ];
        }
      : never
    : ParseStoragePathRoot<Path>;

export const HEX_STRING_PATTERN = /^0x[0-9a-fA-F]*$/;

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;
const DECIMAL = /^(0|[1-9][0-9]*)$/;

type ParseStoragePathRoot<Segment extends string> =
  Segment extends `${infer Root}[${string}]${infer Rest}`
    ? {
        root: Root;
        segments: readonly [
          { kind: "subscript" },
          ...ParseStoragePathSubscripts<Rest>,
        ];
      }
    : { root: Segment; segments: readonly [] };

type ParseStoragePathTail<Tail extends string> =
  Tail extends `${infer Head}.${infer Rest}`
    ? readonly [...ParseStoragePathSegment<Head>, ...ParseStoragePathTail<Rest>]
    : ParseStoragePathSegment<Tail>;

type ParseStoragePathSegment<Segment extends string> =
  Segment extends `${infer Field}[${string}]${infer Rest}`
    ? Field extends ""
      ? readonly [{ kind: "subscript" }, ...ParseStoragePathSubscripts<Rest>]
      : readonly [
          { kind: "field"; name: Field },
          { kind: "subscript" },
          ...ParseStoragePathSubscripts<Rest>,
        ]
    : readonly [{ kind: "field"; name: Segment }];

type ParseStoragePathSubscripts<Tail extends string> =
  Tail extends `[${string}]${infer Rest}`
    ? readonly [{ kind: "subscript" }, ...ParseStoragePathSubscripts<Rest>]
    : readonly [];

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

export function normalizePath(path: string | StoragePath): StoragePath {
  return typeof path === "string" ? parseStoragePath(path) : path;
}

/**
 * Decode a concrete Solidity storage path value from raw slot values.
 *
 * @param layout - Solidity compiler `storageLayout` output.
 * @param path - Human-readable storage path.
 * @param storage - Raw account storage keyed by slot.
 */
export function decodeStoragePath<
  const Layout extends StorageLayout,
  const Path extends string,
>(
  layout: Layout,
  path: Path extends ConcreteStoragePath<Layout> ? Path : never,
  storage: AccountStorage,
): StoragePathToPrimitiveType<Layout, Path>;
export function decodeStoragePath(
  layout: StorageLayout,
  path: string,
  storage: AccountStorage,
): unknown {
  const normalizedPath = normalizeConcreteParsedPath(
    layout,
    normalizePath(path),
  );
  const resolved = resolveStoragePath(layout, normalizedPath);
  const [slot] = resolved;
  if (slot === undefined) {
    throw new Error(
      `storage path did not resolve to a slot: ${formatStoragePath(normalizedPath)}`,
    );
  }
  const slotHex = storageSlot(slot);
  const value = getSlotValue(storage, slotHex);
  if (value === undefined) {
    throw new Error(`storage value not found for slot: ${slotHex}`);
  }
  if (slot.type.encoding === "bytes") {
    return decodeBytesValue(slot, value, storage);
  }
  return decodeValue(slot, value);
}

/**
 * Encode a concrete Solidity storage path value into masked raw slot writes.
 *
 * @param layout - Solidity compiler `storageLayout` output.
 * @param path - Human-readable storage path.
 * @param value - JavaScript value to encode.
 */
export function encodeStoragePath<
  const Layout extends StorageLayout,
  const Path extends string,
>(
  layout: Layout,
  path: Path extends ConcreteStoragePath<Layout> ? Path : never,
  value: StoragePathToPrimitiveType<Layout, Path>,
): SlotWrites;
export function encodeStoragePath(
  layout: StorageLayout,
  path: string,
  value: unknown,
): SlotWrites {
  const normalizedPath = normalizeConcreteParsedPath(
    layout,
    normalizePath(path),
  );
  const resolved = resolveStoragePath(layout, normalizedPath);
  const [slot] = resolved;
  if (slot === undefined) {
    throw new Error(
      `storage path did not resolve to a slot: ${formatStoragePath(normalizedPath)}`,
    );
  }
  if (slot.type.encoding === "bytes") {
    return encodeBytesValue(slot, value);
  }
  return {
    [storageSlot(slot)]: encodeValue(slot, value),
  };
}

function normalizeConcreteParsedPath(
  layout: StorageLayout,
  path: StoragePath,
): StoragePath {
  const resolved = resolveStoragePath(layout, path);
  if (
    resolved.length !== 1 ||
    resolved[0]!.type.encoding === "dynamic_array" ||
    formatStoragePath(resolved[0]!.path) !== formatStoragePath(path)
  ) {
    throw new Error(
      `storage path does not point to a leaf value: ${formatStoragePath(path)}`,
    );
  }
  return path;
}

function normalizeSlot(slot: Hex.Hex): Hex.Hex {
  return Hex.fromNumber(BigInt(slot), { size: 32 });
}

function normalizeSlotValue(value: Hex.Hex): Hex.Hex {
  return Hex.fromNumber(BigInt(value), { size: 32 });
}

function storageSlot(resolved: ResolvedStorageItem): Hex.Hex {
  return Hex.fromNumber(resolved.baseSlot + BigInt(resolved.item.slot), {
    size: 32,
  });
}

function dynamicDataBaseSlot(slot: Hex.Hex): bigint {
  return BigInt(Hash.keccak256(normalizeSlot(slot)));
}

function storageItemByteLength(resolved: ResolvedStorageItem): number {
  return Number(resolved.type.numberOfBytes);
}

function getSlotValue(
  storage: AccountStorage,
  requestedSlot: Hex.Hex,
): Hex.Hex | undefined {
  const normalized = normalizeSlot(requestedSlot);
  const direct = storage[normalized];
  if (direct !== undefined) {
    return normalizeSlotValue(direct);
  }

  for (const [slot, value] of Object.entries(storage)) {
    if (
      normalizeSlot(slot as Hex.Hex).toLowerCase() === normalized.toLowerCase()
    ) {
      return normalizeSlotValue(value as Hex.Hex);
    }
  }
  return undefined;
}

function decodeValue(
  resolved: ResolvedStorageItem,
  slotValue: Hex.Hex,
): unknown {
  const numberOfBytes = storageItemByteLength(resolved);
  const value = extractField(
    BigInt(slotValue),
    resolved.item.offset,
    numberOfBytes,
  );
  const info = parseValueType(resolved.type.label, numberOfBytes);
  switch (info.kind) {
    case "uint":
      return integerResult(value, numberOfBytes);
    case "int":
      return integerResult(decodeSigned(value, info.bits), numberOfBytes);
    case "address":
      return Hex.fromNumber(value, { size: 20 });
    case "bool":
      return value !== 0n;
    case "bytes":
      return Hex.fromNumber(value, { size: numberOfBytes });
    case "enum":
      return Number(value);
  }
}

function decodeBytesValue(
  resolved: ResolvedStorageItem,
  slotValue: Hex.Hex,
  storage: AccountStorage,
): Hex.Hex | string {
  const bytes = decodeBytesPayload(resolved, slotValue, storage);
  if (resolved.type.label === "string") {
    return Hex.toString(bytes);
  }
  return bytes;
}

function decodeBytesPayload(
  resolved: ResolvedStorageItem,
  slotValue: Hex.Hex,
  storage: AccountStorage,
): Hex.Hex {
  const normalized = normalizeSlotValue(slotValue);
  const marker = Number(BigInt(Hex.slice(normalized, 31, 32)));
  if (marker % 2 === 0) {
    const length = marker / 2;
    return Hex.slice(normalized, 0, length);
  }

  const length = bytesLength((BigInt(normalized) - 1n) / 2n, resolved.path);
  const baseSlot = dynamicDataBaseSlot(storageSlot(resolved));
  const chunks: Hex.Hex[] = [];
  for (let index = 0; index < Math.ceil(length / 32); index++) {
    const slot = Hex.fromNumber(baseSlot + BigInt(index), { size: 32 });
    const value = getSlotValue(storage, slot);
    if (value === undefined) {
      throw new Error(`storage value not found for slot: ${slot}`);
    }
    chunks.push(value);
  }
  return Hex.slice(Hex.concat(...chunks), 0, length);
}

function encodeValue(resolved: ResolvedStorageItem, value: unknown): SlotWrite {
  const numberOfBytes = storageItemByteLength(resolved);
  const info = parseValueType(resolved.type.label, numberOfBytes);
  const encoded = encodeField(info, numberOfBytes, value);
  const shift = BigInt(resolved.item.offset * 8);
  const mask = fieldMask(numberOfBytes) << shift;
  return {
    value: Hex.fromNumber(encoded << shift, { size: 32 }),
    mask: Hex.fromNumber(mask, { size: 32 }),
  };
}

function encodeBytesValue(
  resolved: ResolvedStorageItem,
  value: unknown,
): SlotWrites {
  const bytes = bytesPayload(resolved, value);
  if (Hex.size(bytes) <= 31) {
    return {
      [storageSlot(resolved)]: {
        value: encodeShortBytes(bytes),
        mask: fullSlotMask(),
      },
    };
  }

  const slot = storageSlot(resolved);
  const baseSlot = dynamicDataBaseSlot(slot);
  const writes: SlotWrites = {
    [slot]: {
      value: Hex.fromNumber(BigInt(Hex.size(bytes)) * 2n + 1n, { size: 32 }),
      mask: fullSlotMask(),
    },
  };
  for (let offset = 0; offset < Hex.size(bytes); offset += 32) {
    writes[Hex.fromNumber(baseSlot + BigInt(offset / 32), { size: 32 })] = {
      value: Hex.padRight(Hex.slice(bytes, offset, offset + 32), 32),
      mask: fullSlotMask(),
    };
  }
  return writes;
}

function fullSlotMask(): Hex.Hex {
  return Hex.fromNumber((1n << 256n) - 1n, { size: 32 });
}

function bytesPayload(resolved: ResolvedStorageItem, value: unknown): Hex.Hex {
  if (resolved.type.label === "string") {
    if (typeof value !== "string") {
      throw new Error("string value must be a string");
    }
    return Hex.fromString(value);
  }
  if (typeof value !== "string" || !HEX_STRING_PATTERN.test(value)) {
    throw new Error("bytes value must be a hex string");
  }
  if ((value.length - 2) % 2 !== 0) {
    throw new Error("bytes value must have an even number of hex digits");
  }
  return value as Hex.Hex;
}

function encodeShortBytes(bytes: Hex.Hex): Hex.Hex {
  return Hex.concat(
    Hex.padRight(bytes, 31),
    Hex.fromNumber(Hex.size(bytes) * 2, { size: 1 }),
  );
}

function bytesLength(length: bigint, path: StoragePath): number {
  if (length > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(
      `bytes value is too large to decode: ${formatStoragePath(path)}`,
    );
  }
  return Number(length);
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
      if (typeof value !== "string" || !HEX_STRING_PATTERN.test(value)) {
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
  if (typeof value !== "string" || !HEX_STRING_PATTERN.test(value)) {
    throw new Error("fixed bytes value must be a hex string");
  }
  const actualBytes = (value.length - 2) / 2;
  if (!Number.isInteger(actualBytes) || actualBytes !== numberOfBytes) {
    throw new Error(`fixed bytes value must be exactly ${numberOfBytes} bytes`);
  }
  return BigInt(value);
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
  if (HEX_STRING_PATTERN.test(raw)) {
    return { kind: "hex", value: raw as Hex.Hex };
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
