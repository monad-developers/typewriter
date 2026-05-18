import { Hash, Hex } from "ox";
import {
  type IsSingleSlot,
  type ResolvedStorageItem,
  resolveStoragePath,
  type StorageLayout,
  type StorageLayoutToPrimitiveType,
  type StoragePathToPrimitiveType,
  type StorageType,
  storagePathEndsAtValue,
} from "./storage-layout";
import {
  type ConcreteStoragePath,
  formatStoragePath,
  HEX_STRING_PATTERN,
  normalizePath,
  pathToString,
  type StoragePath,
  type StoragePathSubscript,
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
export type { ConcreteStoragePath, StoragePath } from "./storage-path";
export { formatStoragePath, parseStoragePath } from "./storage-path";
export type {
  AsyncSlotGetter,
  DeepPromise,
  SlotGetter,
  SlotMap,
  StorageProxy,
  SyncSlotGetter,
} from "./storage-proxy";
export { createStorageProxy } from "./storage-proxy";

export type StorageVariableUpdate = ResolvedStorageItem & {
  value?: Hex.Hex;
};

export type SlotWrite = {
  value: Hex.Hex;
  mask: Hex.Hex;
};

export type SlotWrites = {
  [slot: Hex.Hex]: SlotWrite;
};

/**
 * Key-value map of storage slots to their hex values.
 */
export type AccountStorage = {
  [slot: Hex.Hex]: Hex.Hex;
};

/**
 * Compute storage slots for a Solidity storage path.
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
 * Normalize and validate that a storage path resolves to one concrete leaf value.
 */
export function normalizeConcretePath(
  layout: StorageLayout,
  pathInput: string | StoragePath | ConcreteStoragePath,
): ConcreteStoragePath {
  const path = normalizePath(pathInput);
  const resolved = resolveStoragePath(layout, path);
  if (!resolvedPathEndsAtValue(resolved, path)) {
    throw new Error(
      `storage path does not point to a leaf value: ${pathToString(pathInput)}`,
    );
  }
  return path as ConcreteStoragePath;
}

/**
 * Match raw storage slots back to known Solidity storage paths.
 *
 * @param layout - Solidity compiler `storageLayout` output.
 * @param slot - Changed slot or slots.
 * @param knownPaths - Optional concrete paths used to match irreversible slots such as keyed mappings.
 *
 * @dev Mappings are not reversible from a raw slot alone. When `knownPaths` is omitted, unmatched slots throw if the layout contains mappings instead of silently omitting possible mapping writes.
 */
export function getStoragePath(
  layout: StorageLayout,
  slot: Hex.Hex | Hex.Hex[],
  knownPaths?: readonly (string | StoragePath)[],
): StoragePath[] {
  const { slots: layoutSlots, mappingPaths } = collectLayoutSlots(layout);
  const knownSlots = knownPaths?.flatMap((knownPath) =>
    resolveStoragePath(layout, normalizePath(knownPath)),
  );
  const matches: StoragePath[] = [];
  const seen = new Set<string>();

  for (const changedSlot of Array.isArray(slot) ? slot : [slot]) {
    const normalizedSlot = normalizeSlot(changedSlot);
    const matchedLayout = addSlotMatches(
      matches,
      seen,
      layoutSlots,
      normalizedSlot,
    );
    const matchedKnown =
      knownSlots !== undefined &&
      addSlotMatches(matches, seen, knownSlots, normalizedSlot);
    if (!matchedLayout && !matchedKnown && knownPaths === undefined) {
      const [mappingPath] = mappingPaths;
      if (mappingPath !== undefined) {
        throw new Error(mappingPathError(mappingPath));
      }
    }
  }

  return matches;
}

function addSlotMatches(
  matches: StoragePath[],
  seen: Set<string>,
  knownSlots: readonly ResolvedStorageItem[],
  normalizedSlot: Hex.Hex,
): boolean {
  let matched = false;
  for (const knownItem of knownSlots) {
    if (storageSlot(knownItem).toLowerCase() !== normalizedSlot.toLowerCase()) {
      continue;
    }
    matched = true;
    const key = formatStoragePath(knownItem.path);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    matches.push(knownItem.path);
  }
  return matched;
}

function collectLayoutSlots(layout: StorageLayout): {
  slots: ResolvedStorageItem[];
  mappingPaths: StoragePath[];
} {
  const paths: StoragePath[] = [];
  const mappingPaths: StoragePath[] = [];
  for (const item of layout.storage) {
    collectReversiblePaths(
      layout,
      findStorageType(layout, item.type),
      { root: item.label, segments: [] },
      paths,
      mappingPaths,
    );
  }

  return {
    slots: paths.flatMap((path) => resolveStoragePath(layout, path)),
    mappingPaths,
  };
}

function collectReversiblePaths(
  layout: StorageLayout,
  type: StorageType,
  path: StoragePath,
  paths: StoragePath[],
  mappingPaths: StoragePath[],
): void {
  if (type.encoding === "mapping") {
    mappingPaths.push(path);
    return;
  }
  if (type.members !== undefined) {
    for (const member of type.members) {
      collectReversiblePaths(
        layout,
        findStorageType(layout, member.type),
        {
          root: path.root,
          segments: [...path.segments, { kind: "field", name: member.label }],
        },
        paths,
        mappingPaths,
      );
    }
    return;
  }
  if (type.encoding === "inplace" && type.base !== undefined) {
    const baseType = findStorageType(layout, type.base);
    for (let index = 0; index < fixedArrayLength(type); index++) {
      collectReversiblePaths(
        layout,
        baseType,
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
        paths,
        mappingPaths,
      );
    }
    return;
  }
  paths.push(path);
}

/**
 * Decode a concrete Solidity storage path value from raw slot values.
 *
 * @param layout - Solidity compiler `storageLayout` output.
 * @param path - Human-readable or structured storage path.
 * @param storage - Raw account storage keyed by slot.
 */
export function decodeStoragePath<
  Layout extends StorageLayout,
  Path extends string | ConcreteStoragePath,
>(
  layout: Layout,
  path: Path,
  storage: AccountStorage,
): StoragePathToPrimitiveType<Layout, Path> {
  const normalizedPath = normalizeConcretePath(layout, path);
  const resolved = resolveStoragePath(layout, normalizedPath);
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
  if (slot.type.encoding === "bytes") {
    return decodeBytesValue(slot, value, storage) as StoragePathToPrimitiveType<
      Layout,
      Path
    >;
  }
  return decodeValue(slot, value) as StoragePathToPrimitiveType<Layout, Path>;
}

/**
 * Encode a concrete Solidity storage path value into masked raw slot writes.
 *
 * @param layout - Solidity compiler `storageLayout` output.
 * @param path - Human-readable or structured storage path.
 * @param value - JavaScript value to encode.
 */
export function encodeStoragePath<
  Layout extends StorageLayout,
  Path extends string | ConcreteStoragePath,
>(
  layout: Layout,
  path: Path,
  value: StoragePathToPrimitiveType<Layout, Path>,
): SlotWrites {
  const normalizedPath = normalizeConcretePath(layout, path);
  const resolved = resolveStoragePath(layout, normalizedPath);
  const [slot] = resolved;
  if (slot === undefined) {
    throw new Error(
      `storage path did not resolve to a slot: ${pathToString(path)}`,
    );
  }
  if (slot.type.encoding === "bytes") {
    return encodeBytesValue(slot, value);
  }
  return {
    [storageSlot(slot)]: encodeValue(slot, value),
  };
}

/**
 * Encode a decoded, contract-shaped state object into raw storage slots.
 *
 * The state shape must mirror {@link StorageLayoutToPrimitiveType}: structs are
 * objects, fixed/dynamic arrays are arrays, and mappings are records whose keys
 * are the concrete known mapping keys. Mapping keys do not need to be inferred
 * from slots in this direction; they come from the decoded object itself.
 */
export function encodeStorage<Layout extends StorageLayout>(
  layout: Layout,
  state: StorageLayoutToPrimitiveType<Layout>,
): AccountStorage {
  const storage: AccountStorage = {};
  const root = state as Record<string, unknown>;
  for (const item of layout.storage) {
    const type = findStorageType(layout, item.type);
    const value = root[item.label];
    encodeStateValue(
      layout,
      type,
      { root: item.label, segments: [] },
      value,
      storage,
    );
  }
  return storage;
}

function encodeStateValue(
  layout: StorageLayout,
  type: StorageType,
  path: StoragePath,
  value: unknown,
  storage: AccountStorage,
): void {
  if (value === undefined) {
    throw new Error(
      `missing decoded state value for path: ${formatStoragePath(path)}`,
    );
  }

  if (isLeafStorageType(type)) {
    mergeStorageWrites(layout, path, value, storage);
    return;
  }

  if (type.members !== undefined) {
    assertRecordValue(value, path);
    for (const member of type.members) {
      encodeStateValue(
        layout,
        findStorageType(layout, member.type),
        appendField(path, member.label),
        value[member.label],
        storage,
      );
    }
    return;
  }

  if (type.base !== undefined) {
    assertArrayValue(value, path);
    if (type.encoding === "dynamic_array") {
      writeDynamicArrayLength(layout, path, value.length, storage);
    } else {
      const length = fixedArrayLength(type);
      if (value.length !== length) {
        throw new Error(
          `fixed array length mismatch at ${formatStoragePath(path)}: expected ${length}, got ${value.length}`,
        );
      }
    }
    const baseType = findStorageType(layout, type.base);
    for (let index = 0; index < value.length; index++) {
      encodeStateValue(
        layout,
        baseType,
        appendSubscript(path, { kind: "number", value: BigInt(index) }),
        value[index],
        storage,
      );
    }
    return;
  }

  if (type.key !== undefined && type.value !== undefined) {
    assertRecordValue(value, path);
    const keyType = findStorageType(layout, type.key);
    const valueType = findStorageType(layout, type.value);
    for (const [key, entry] of Object.entries(value)) {
      encodeStateValue(
        layout,
        valueType,
        appendSubscript(path, subscriptForMappingKey(keyType, key, path)),
        entry,
        storage,
      );
    }
    return;
  }

  throw new Error(
    `unsupported storage type '${type.label}' at ${formatStoragePath(path)}`,
  );
}

function mergeStorageWrites(
  layout: StorageLayout,
  path: StoragePath,
  value: unknown,
  storage: AccountStorage,
): void {
  const writes = encodeStoragePath(
    layout,
    normalizeConcretePath(layout, path),
    value as never,
  );
  for (const [slot, write] of Object.entries(writes)) {
    storage[slot as Hex.Hex] = applySlotWrite(
      getSlotValue(storage, slot as Hex.Hex),
      write,
    );
  }
}

function applySlotWrite(
  existing: Hex.Hex | undefined,
  write: SlotWrite,
): Hex.Hex {
  const base = existing === undefined ? 0n : BigInt(existing);
  const mask = BigInt(write.mask);
  const next = (base & ~mask) | (BigInt(write.value) & mask);
  return Hex.fromNumber(next, { size: 32 });
}

function writeDynamicArrayLength(
  layout: StorageLayout,
  path: StoragePath,
  length: number,
  storage: AccountStorage,
): void {
  const resolved = resolveStoragePath(layout, path);
  if (!isDynamicArrayRoot(resolved, path)) {
    throw new Error(
      `storage path is not a dynamic array root: ${formatStoragePath(path)}`,
    );
  }
  storage[storageSlot(resolved[0]!)] = Hex.fromNumber(BigInt(length), {
    size: 32,
  });
}

function appendField(path: StoragePath, name: string): StoragePath {
  return {
    root: path.root,
    segments: [...path.segments, { kind: "field", name }],
  };
}

function appendSubscript(
  path: StoragePath,
  value: StoragePathSubscript,
): StoragePath {
  return {
    root: path.root,
    segments: [...path.segments, { kind: "subscript", value }],
  };
}

function subscriptForMappingKey(
  type: StorageType,
  key: string,
  path: StoragePath,
): StoragePathSubscript {
  const label = type.label;
  if (label === "address") {
    if (!HEX_STRING_PATTERN.test(key)) {
      throw new Error(
        `mapping key on '${formatStoragePath(path)}' must be a hex string for key type '${label}': '${key}'`,
      );
    }
    return { kind: "hex", value: key as Hex.Hex };
  }
  if (label === "bool") {
    if (key === "true" || key === "false") {
      return { kind: "bool", value: key === "true" };
    }
    throw new Error(
      `mapping key on '${formatStoragePath(path)}' must be 'true' or 'false' for key type '${label}': '${key}'`,
    );
  }
  if (/^u?int[0-9]*$/.test(label)) {
    if (!/^-?(0|[1-9][0-9]*)$/.test(key)) {
      throw new Error(
        `mapping key on '${formatStoragePath(path)}' must be a decimal integer for key type '${label}': '${key}'`,
      );
    }
    return { kind: "number", value: BigInt(key) };
  }
  if (/^bytes([1-9]|[12][0-9]|3[0-2])$/.test(label)) {
    if (!HEX_STRING_PATTERN.test(key)) {
      throw new Error(
        `mapping key on '${formatStoragePath(path)}' must be a hex string for key type '${label}': '${key}'`,
      );
    }
    return { kind: "hex", value: key as Hex.Hex };
  }
  throw new Error(
    `unsupported mapping key type '${label}' on '${formatStoragePath(path)}'`,
  );
}

function assertRecordValue(
  value: unknown,
  path: StoragePath,
): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(
      `decoded state value must be an object: ${formatStoragePath(path)}`,
    );
  }
}

function assertArrayValue(
  value: unknown,
  path: StoragePath,
): asserts value is readonly unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(
      `decoded state value must be an array: ${formatStoragePath(path)}`,
    );
  }
}

function findStorageType(layout: StorageLayout, typeId: string): StorageType {
  const type = layout.types[typeId];
  if (type === undefined) {
    throw new Error(`storage type not found: ${typeId}`);
  }
  return type;
}

function isLeafStorageType(type: StorageType): boolean {
  return isValueStorageType(type) || type.encoding === "bytes";
}

function isValueStorageType(type: StorageType): boolean {
  if (type.encoding !== "inplace" || type.members !== undefined) return false;
  return type.base === undefined && type.key === undefined;
}

function fixedArrayLength(type: StorageType): number {
  const match = /\[([0-9]+)\]$/.exec(type.label);
  if (match === null) {
    throw new Error(`fixed array type '${type.label}' is missing length`);
  }
  return Number(match[1]);
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
