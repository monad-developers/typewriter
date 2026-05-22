import { Hash, Hex } from "ox";
import {
  type ResolvedStorageItem,
  resolveStoragePath,
  type StorageLayout,
} from "./storage-layout";
import { formatStoragePath, type StoragePath } from "./storage-path";

export type ParsedValueType =
  | { kind: "uint"; bits: number }
  | { kind: "int"; bits: number }
  | { kind: "address"; bits: 160 }
  | { kind: "bool"; bits: 8 }
  | { kind: "bytes"; bytes: number }
  | { kind: "enum"; bytes: number };

export function assertConcreteLeafPath(
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

export function normalizeSlot(slot: Hex.Hex): Hex.Hex {
  return Hex.fromNumber(BigInt(slot), { size: 32 });
}

export function normalizeSlotValue(value: Hex.Hex): Hex.Hex {
  return Hex.fromNumber(BigInt(value), { size: 32 });
}

export function storageSlot(resolved: ResolvedStorageItem): Hex.Hex {
  return Hex.fromNumber(resolved.baseSlot + BigInt(resolved.item.slot), {
    size: 32,
  });
}

export function dynamicDataBaseSlot(slot: Hex.Hex): bigint {
  return BigInt(Hash.keccak256(normalizeSlot(slot)));
}

export function storageItemByteLength(resolved: ResolvedStorageItem): number {
  return Number(resolved.type.numberOfBytes);
}

export function fieldMask(numberOfBytes: number): bigint {
  return (1n << BigInt(numberOfBytes * 8)) - 1n;
}

export function parseValueType(
  type: string,
  numberOfBytes: number,
): ParsedValueType {
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
