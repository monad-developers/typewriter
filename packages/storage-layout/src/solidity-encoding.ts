import { Hex } from "ox";
import type { StorageType } from "./storage-layout";

// Low-level Solidity storage-encoding rules shared across the package: type
// predicates, type-label parsing, and slot math. Kept dependency-free (only the
// `StorageType` type, erased at runtime) so any module can import it without
// risking an import cycle through `storage-layout`.

/** Left-pads a slot to its canonical 32-byte hex form. */
export function normalizeSlot(slot: Hex.Hex): Hex.Hex {
  return Hex.fromNumber(BigInt(slot), { size: 32 });
}

/**
 * Whether a type is stored inline in a single slot with no hashing, members, or
 * array base — i.e. an integer, address, bool, fixed-bytes, or enum.
 */
export function isValueType(type: StorageType): boolean {
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

/** Parses the bit width of a Solidity `uint`/`int` type label. */
export function integerBits(label: string, prefix: "uint" | "int"): number {
  const suffix = label.slice(prefix.length);
  const bits = suffix === "" ? 256 : Number(suffix);
  if (!Number.isInteger(bits) || bits < 8 || bits > 256 || bits % 8 !== 0) {
    throw new Error(`invalid Solidity integer type: ${label}`);
  }
  return bits;
}

/** Parses the declared length of a fixed-size array type label. */
export function fixedArrayLength(type: StorageType): number {
  const match = /\[([0-9]+)\]$/.exec(type.label);
  if (match === null) {
    throw new Error(`fixed array type '${type.label}' is missing length`);
  }
  return Number(match[1]);
}

/**
 * Slot index and byte offset of the array element at `index`, relative to the
 * array's base slot. Sub-32-byte value types are packed several per slot; every
 * other element occupies a whole number of slots.
 */
export function arrayElementLocation(
  type: StorageType,
  index: bigint,
): { slot: bigint; offset: number } {
  const numberOfBytes = Number(type.numberOfBytes);
  if (isValueType(type)) {
    const valuesPerSlot = BigInt(Math.floor(32 / numberOfBytes));
    return {
      slot: index / valuesPerSlot,
      offset: Number(index % valuesPerSlot) * numberOfBytes,
    };
  }
  return {
    slot: index * BigInt(Math.ceil(numberOfBytes / 32)),
    offset: 0,
  };
}
