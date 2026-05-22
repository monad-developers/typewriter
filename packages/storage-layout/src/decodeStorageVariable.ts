import { Hex } from "ox";
import {
  type ResolvedStorageItem,
  resolveStoragePath,
  type StorageLayout,
  type StorageVariableToPrimitiveType,
} from "./storage-layout";
import {
  formatStoragePath,
  normalizePath,
  type StoragePath,
} from "./storage-path";
import {
  assertConcreteLeafPath,
  dynamicDataBaseSlot,
  fieldMask,
  normalizeSlot,
  normalizeSlotValue,
  parseValueType,
  storageItemByteLength,
  storageSlot,
} from "./storage-variable";
import type { AccountStorage, ConcreteStorageVariable } from "./types";

/**
 * Decode a concrete Solidity storage path value from raw slot values.
 *
 * @param layout - Solidity compiler `storageLayout` output.
 * @param variable - Human-readable storage path.
 * @param storage - Raw account storage keyed by slot.
 */
export function decodeStorageVariable<
  const layout extends StorageLayout,
  const variable extends ConcreteStorageVariable<layout>,
>(
  layout: layout,
  variable: variable,
  storage: AccountStorage,
): StorageVariableToPrimitiveType<layout, variable> {
  const normalizedPath = assertConcreteLeafPath(
    layout,
    normalizePath(variable as string),
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
    return decodeBytesValue(
      slot,
      value,
      storage,
    ) as StorageVariableToPrimitiveType<layout, variable>;
  }
  return decodeValue(slot, value) as StorageVariableToPrimitiveType<
    layout,
    variable
  >;
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
