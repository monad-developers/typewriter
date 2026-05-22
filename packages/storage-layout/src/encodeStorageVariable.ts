import { Hex } from "ox";
import {
  type ResolvedStorageItem,
  resolveStoragePath,
  type StorageLayout,
  type StorageVariableToPrimitiveType,
} from "./storage-layout";
import {
  formatStoragePath,
  HEX_STRING_PATTERN,
  normalizePath,
} from "./storage-path";
import {
  assertConcreteLeafPath,
  dynamicDataBaseSlot,
  fieldMask,
  type ParsedValueType,
  parseValueType,
  storageItemByteLength,
  storageSlot,
} from "./storage-variable";
import type { ConcreteStorageVariable, SlotWrite, SlotWrites } from "./types";

/**
 * Encode a concrete Solidity storage path value into masked raw slot writes.
 *
 * @param layout - Solidity compiler `storageLayout` output.
 * @param variable - Human-readable storage path.
 * @param value - JavaScript value to encode.
 */
export function encodeStorageVariable<
  const layout extends StorageLayout,
  const variable extends ConcreteStorageVariable<layout>,
>(
  layout: layout,
  variable: variable,
  value: StorageVariableToPrimitiveType<layout, variable>,
): SlotWrites {
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
  if (slot.type.encoding === "bytes") {
    return encodeBytesValue(slot, value);
  }
  return {
    [storageSlot(slot)]: encodeValue(slot, value),
  };
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
