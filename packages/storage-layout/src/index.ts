import { Hex } from "ox";
import {
  type IsSingleSlot,
  type ResolvedStorageItem,
  resolveStoragePath,
  type StorageItem,
  type StorageLayout,
  type StoragePathToPrimitiveType,
  storagePathEndsAtValue,
} from "./storage-layout";
import {
  formatStoragePath,
  HEX_STRING_PATTERN,
  normalizePath,
  pathToString,
  type StoragePath,
} from "./storage-path";

export type {
  ExtractStoragePaths,
  ExtractVariableNames,
  IsSingleSlot,
  StorageLayout,
  StorageLayoutToPrimitiveType,
  StoragePathToPrimitiveType,
  StorageType,
} from "./storage-layout";
export type { StoragePath } from "./storage-path";
export { formatStoragePath, parseStoragePath } from "./storage-path";

export type StorageVariableUpdate = ResolvedStorageItem & {
  value?: Hex.Hex;
};

export type SlotWrite = {
  slot: Hex.Hex;
  value: Hex.Hex;
};

/**
 * Key-value map of storage slots to their hex values.
 */
export type AccountStorage = {
  [slot: Hex.Hex]: Hex.Hex;
};

/**
 * Compute storage slots for a concrete Solidity storage path.
 *
 * Dynamic array roots resolve to their length slot. Indexed dynamic-array paths
 * resolve to element slot(s).
 *
 * @param layout - Solidity compiler `storageLayout` output.
 * @param pathInput - Human-readable or structured storage path.
 */
export function getStorageSlot<
  Layout extends StorageLayout,
  Path extends string | StoragePath,
>(
  layout: Layout,
  pathInput: Path,
): IsSingleSlot<Layout, Path> extends true ? Hex.Hex : Hex.Hex[] {
  const slots = uniqueSlots(
    resolveStoragePath(layout, normalizePath(pathInput)),
  );
  return (slots.length === 1 ? slots[0]! : slots) as IsSingleSlot<
    Layout,
    Path
  > extends true
    ? Hex.Hex
    : Hex.Hex[];
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
 * Match raw storage slots back to known Solidity storage paths.
 *
 * @param layout - Solidity compiler `storageLayout` output.
 * @param slot - Changed slot or slots.
 *
 * @dev Mappings are not reversible from a raw slot alone, so layouts containing mappings throw instead of silently omitting them.
 */
export function getStoragePath(
  layout: StorageLayout,
  slot: Hex.Hex | Hex.Hex[],
): StoragePath[] {
  const knownSlots: ResolvedStorageItem[] = [];
  for (const item of layout.storage) {
    assertReversibleStorageItem(layout, item, {
      root: item.label,
      segments: [],
    });
    knownSlots.push(
      ...resolveStoragePath(layout, { root: item.label, segments: [] }),
    );
  }
  const matches: StoragePath[] = [];
  const seen = new Set<string>();

  for (const changedSlot of Array.isArray(slot) ? slot : [slot]) {
    const normalizedSlot = normalizeSlot(changedSlot);
    for (const knownItem of knownSlots) {
      if (
        storageSlot(knownItem).toLowerCase() === normalizedSlot.toLowerCase()
      ) {
        const key = formatStoragePath(knownItem.path);
        if (seen.has(key)) {
          continue;
        }
        seen.add(key);
        matches.push(knownItem.path);
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
  const normalizedPath = normalizePath(path);
  const resolved = resolveStoragePath(layout, normalizedPath);
  if (isDynamicArrayRoot(resolved, normalizedPath)) {
    return decodeDynamicArray(
      layout,
      normalizedPath,
      resolved[0]!,
      storage,
    ) as StoragePathToPrimitiveType<Layout, Path>;
  }
  if (!resolvedPathEndsAtValue(resolved, normalizedPath)) {
    throw new Error(
      `storage path does not point to a leaf value: ${pathToString(path)}`,
    );
  }

  const [slot] = resolved;
  if (slot === undefined) {
    throw new Error(
      `storage path did not resolve to a slot: ${pathToString(path)}`,
    );
  }
  const slotHex = storageSlot(slot);
  const value = getSlotValue(storage, slotHex);
  if (value === undefined) {
    throw new Error(`storage value not found for slot: ${slotHex}`);
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
  const normalizedPath = normalizePath(path);
  const resolved = resolveStoragePath(layout, normalizedPath);
  if (isDynamicArrayRoot(resolved, normalizedPath)) {
    // TODO: Full dynamic-array encoding needs an explicit stale-slot policy for
    // shrinking arrays. Solidity updates the length, but old element slots remain
    // unless deleted, so callers may need opt-in clearing semantics.
    throw new Error(
      `encoding dynamic array roots is not implemented yet: ${pathToString(path)}`,
    );
  }
  if (!resolvedPathEndsAtValue(resolved, normalizedPath)) {
    throw new Error(
      `storage path does not point to a leaf value: ${pathToString(path)}`,
    );
  }

  const [slot] = resolved;
  if (slot === undefined) {
    throw new Error(
      `storage path did not resolve to a slot: ${pathToString(path)}`,
    );
  }
  const slotHex = storageSlot(slot);
  const existing = getSlotValue(storage, slotHex);
  if (isPartialSlot(slot) && existing === undefined) {
    throw new Error(
      `existing storage value is required to encode packed path: ${formatStoragePath(slot.path)}`,
    );
  }
  return [
    {
      slot: slotHex,
      value: encodeValue(slot, value, existing),
    },
  ];
}

function uniqueSlots(slots: readonly ResolvedStorageItem[]): Hex.Hex[] {
  const unique: Hex.Hex[] = [];
  const seen = new Set<string>();
  for (const resolved of slots) {
    const slot = storageSlot(resolved);
    const key = slot.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    unique.push(slot);
  }
  return unique;
}

function resolvedPathEndsAtValue(
  resolved: readonly ResolvedStorageItem[],
  path: StoragePath,
): boolean {
  return (
    resolved.length === 1 &&
    resolved[0]!.type.encoding !== "dynamic_array" &&
    formatStoragePath(resolved[0]!.path) === formatStoragePath(path)
  );
}

function isDynamicArrayRoot(
  resolved: readonly ResolvedStorageItem[],
  path: StoragePath,
): boolean {
  return (
    resolved.length === 1 &&
    resolved[0]!.type.encoding === "dynamic_array" &&
    formatStoragePath(resolved[0]!.path) === formatStoragePath(path)
  );
}

function decodeDynamicArray(
  layout: StorageLayout,
  path: StoragePath,
  arraySlot: ResolvedStorageItem,
  storage: AccountStorage,
): unknown[] {
  const lengthSlot = storageSlot(arraySlot);
  const lengthValue = getSlotValue(storage, lengthSlot);
  if (lengthValue === undefined) {
    throw new Error(`storage value not found for slot: ${lengthSlot}`);
  }
  const length = dynamicArrayLength(lengthValue, path);
  const values: unknown[] = [];
  for (let index = 0; index < length; index++) {
    values.push(
      decodeStorage(
        layout,
        {
          root: path.root,
          segments: [
            ...path.segments,
            {
              kind: "subscript",
              value: { kind: "number", value: BigInt(index) },
            },
          ],
        },
        storage,
      ),
    );
  }
  return values;
}

function dynamicArrayLength(value: Hex.Hex, path: StoragePath): number {
  const length = BigInt(value);
  if (length > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(
      `dynamic array length is too large to decode: ${formatStoragePath(path)}`,
    );
  }
  return Number(length);
}

function assertReversibleStorageItem(
  layout: StorageLayout,
  item: StorageItem,
  path: StoragePath,
): void {
  const type = layout.types[item.type];
  if (type === undefined) {
    throw new Error(`storage type not found: ${item.type}`);
  }
  if (type.encoding === "mapping") {
    throw new Error(mappingPathError(path));
  }
  if (type.members === undefined) {
    if (type.encoding === "inplace" && type.base !== undefined) {
      assertReversibleStorageItem(
        layout,
        {
          astId: item.astId,
          contract: item.contract,
          label: `${item.label}[0]`,
          offset: 0,
          slot: "0",
          type: type.base,
        },
        {
          root: path.root,
          segments: [
            ...path.segments,
            { kind: "subscript", value: { kind: "number", value: 0n } },
          ],
        },
      );
    }
    return;
  }
  for (const member of type.members) {
    assertReversibleStorageItem(layout, member, {
      root: path.root,
      segments: [...path.segments, { kind: "field", name: member.label }],
    });
  }
}

function mappingPathError(path: StoragePath): string {
  return `cannot infer storage path for mapping '${formatStoragePath(path)}' from raw slots: Solidity mapping keys are hashed into storage slots and cannot be reversed from a slot alone`;
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

function isPartialSlot(resolved: ResolvedStorageItem): boolean {
  return resolved.item.offset !== 0 || storageItemByteLength(resolved) !== 32;
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

function encodeValue(
  resolved: ResolvedStorageItem,
  value: unknown,
  existingSlotValue: Hex.Hex | undefined,
): Hex.Hex {
  const numberOfBytes = storageItemByteLength(resolved);
  const info = parseValueType(resolved.type.label, numberOfBytes);
  const encoded = encodeField(info, numberOfBytes, value);
  const base = existingSlotValue === undefined ? 0n : BigInt(existingSlotValue);
  const shift = BigInt(resolved.item.offset * 8);
  const mask = fieldMask(numberOfBytes) << shift;
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
