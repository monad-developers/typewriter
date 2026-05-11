import { Hex } from "ox";
import {
  resolveStoragePath,
  type StorageLayout,
  type StoragePathToPrimitiveType,
  type StorageSlot,
  storagePathEndsAtValue,
} from "./storage-layout";
import {
  formatStoragePath,
  HEX_STRING_PATTERN,
  type HexString,
  normalizePath,
  pathToString,
  type StoragePath,
} from "./storage-path";

export type {
  CustomTypeError,
  ExtractMappingType,
  ExtractMappingVariableNames,
  ExtractVariableNames,
  IsVariableSingleSlot,
  Pretty,
  StorageItem,
  StorageLayout,
  StorageLayoutToVariableType,
  StorageLayoutToVariableTypes,
  StoragePathToPrimitiveType,
  StorageSlot,
  StorageType,
} from "./storage-layout";
export type {
  HexString,
  StoragePath,
  StoragePathSegment,
  StoragePathSubscript,
} from "./storage-path";
export { formatStoragePath, parseStoragePath } from "./storage-path";

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

/**
 * Compute storage slots for a concrete Solidity storage path.
 *
 * @param layout - Solidity compiler `storageLayout` output.
 * @param pathInput - Human-readable or structured storage path.
 */
export function getStorageSlot(
  layout: StorageLayout,
  pathInput: string | StoragePath,
): StorageSlot[] {
  return resolveStoragePath(layout, normalizePath(pathInput));
}

/**
 * Return whether a storage path points at a value that cannot be narrowed further.
 */
export function isStoragePathEnd(
  layout: StorageLayout,
  pathInput: string | StoragePath,
): boolean {
  return storagePathEndsAtValue(layout, normalizePath(pathInput));
}

/**
 * Match raw storage slot changes back to known Solidity storage paths.
 *
 * @param layout - Solidity compiler `storageLayout` output.
 * @param changes - Changed slots, optionally with new values.
 * @param knownPaths - Universe of paths that may be matched.
 *
 * @dev Mappings are not reversible from a raw slot alone. Pass known keyed paths once mapping support is implemented.
 */
export function getStoragePath(
  layout: StorageLayout,
  changes: readonly StorageSlotChange[],
  options: { knownPaths?: readonly (string | StoragePath)[] } = {},
): StoragePath[] {
  const knownPaths = options.knownPaths ?? [];
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
 */
export function decodeStorage<
  Layout extends StorageLayout,
  Path extends string | StoragePath,
>(
  layout: Layout,
  path: Path,
  storage: AccountStorage,
): StoragePathToPrimitiveType<Layout, Path> {
  if (!isStoragePathEnd(layout, path)) {
    throw new Error(
      `storage path does not point to a leaf value: ${pathToString(path)}`,
    );
  }

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
  if (!isStoragePathEnd(layout, path)) {
    throw new Error(
      `storage path does not point to a leaf value: ${pathToString(path)}`,
    );
  }

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

function normalizeSlot(slot: HexString): HexString {
  return Hex.fromNumber(BigInt(slot), { size: 32 });
}

function normalizeSlotValue(value: HexString): HexString {
  return Hex.fromNumber(BigInt(value), { size: 32 });
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
