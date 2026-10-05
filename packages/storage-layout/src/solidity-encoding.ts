import { Address, Hash, Hex } from "ox";
import type { StorageType } from "./storage-layout";
import { type StoragePathSubscript, subscriptToInteger } from "./storage-path";

// Low-level Solidity storage-encoding rules shared across the package: slot
// words, value-type classification, mapping-key encoding, and slot math. Only
// types come from `storage-layout` (erased at runtime), so any module can
// import this file without an import cycle.

/** Encodes a slot index or slot value as a canonical 32-byte word. */
export function toWord(value: bigint): Hex.Hex {
  return Hex.fromNumber(value, { size: 32 });
}

/**
 * The low 20 bytes of `value` as an EIP-55 checksummed address, like viem and
 * abitype return. Other hex values stay lowercase.
 */
export function toAddress(value: bigint): Address.Address {
  return Address.checksum(Hex.fromNumber(value, { size: 20 }));
}

/** keccak256 of the 32-byte word `slot`, as a slot index. */
export function keccakSlot(slot: bigint): bigint {
  return BigInt(Hash.keccak256(toWord(slot)));
}

// --- Value types -------------------------------------------------------------

/** A Solidity value type: one that is stored inline in a single slot. */
export type ValueType =
  | { kind: "uint" | "int"; bits: number }
  | { kind: "address" }
  | { kind: "bool" }
  | { kind: "fixedBytes"; size: number }
  | { kind: "enum" };

const INTEGER_LABEL = /^(u?)int([0-9]*)$/;
const FIXED_BYTES_LABEL = /^bytes([1-9]|[12][0-9]|3[0-2])$/;

/**
 * Classify a value type (integer, address, bool, fixed bytes, or enum), or
 * return `undefined` if `type` is not a value type.
 */
export function parseValueType(type: StorageType): ValueType | undefined {
  if (
    type.encoding !== "inplace" ||
    type.members !== undefined ||
    type.base !== undefined
  ) {
    return undefined;
  }
  const { label } = type;
  if (label === "address") return { kind: "address" };
  if (label === "bool") return { kind: "bool" };
  if (label.startsWith("enum ")) return { kind: "enum" };

  const bytes = FIXED_BYTES_LABEL.exec(label);
  if (bytes !== null) return { kind: "fixedBytes", size: Number(bytes[1]) };

  const integer = INTEGER_LABEL.exec(label);
  if (integer !== null) {
    const bits = integer[2] === "" ? 256 : Number(integer[2]);
    if (bits < 8 || bits > 256 || bits % 8 !== 0) {
      throw new Error(`invalid Solidity integer type: ${label}`);
    }
    return { kind: integer[1] === "u" ? "uint" : "int", bits };
  }
  return undefined;
}

export function isValueType(type: StorageType): boolean {
  return parseValueType(type) !== undefined;
}

/** Smallest and largest value of a Solidity integer type. */
export function integerRange(type: { kind: "uint" | "int"; bits: number }): {
  min: bigint;
  max: bigint;
} {
  const bits = BigInt(type.bits);
  return type.kind === "uint"
    ? { min: 0n, max: (1n << bits) - 1n }
    : { min: -(1n << (bits - 1n)), max: (1n << (bits - 1n)) - 1n };
}

// --- Mapping keys ------------------------------------------------------------

/**
 * ABI-encode a mapping key as the 32-byte word that Solidity hashes with the
 * mapping's slot.
 *
 * @param mappingPath - The mapping's formatted path, for error messages.
 */
export function encodeMappingKey(
  keyType: StorageType,
  key: StoragePathSubscript,
  mappingPath: string,
): Hex.Hex {
  const valueType = parseValueType(keyType);
  const invalid = (expected: string) =>
    new Error(`mapping key for '${mappingPath}' must be ${expected}`);

  switch (valueType?.kind) {
    case "address":
      if (key.kind !== "hex") throw invalid("an address hex string");
      if (Hex.size(key.value) !== 20) throw invalid("20 bytes");
      return Hex.padLeft(key.value, 32);
    case "bool":
      if (key.kind !== "bool") throw invalid("a boolean");
      return toWord(key.value ? 1n : 0n);
    case "uint":
    case "int": {
      const value = subscriptToInteger(key);
      if (value === undefined) throw invalid("an integer");
      const { min, max } = integerRange(valueType);
      if (value < min || value > max) {
        throw invalid(`within the ${keyType.label} range ${min} to ${max}`);
      }
      return toWord(BigInt.asUintN(256, value));
    }
    case "fixedBytes":
      if (key.kind !== "hex") throw invalid("a fixed bytes hex string");
      if (Hex.size(key.value) !== valueType.size) {
        throw invalid(`${valueType.size} bytes`);
      }
      return Hex.padRight(key.value, 32);
    default:
      // TODO: Solidity supports dynamic bytes/string mapping keys, but their
      // slot derivation hashes the raw key bytes rather than ABI-padding a
      // fixed-width key. Leave them unsupported until we add explicit tests
      // for those storage rules.
      throw new Error(`unsupported mapping key type: ${keyType.label}`);
  }
}

/**
 * Decode a mapping key from the 32-byte word Solidity hashed, the inverse of
 * {@link encodeMappingKey}. Returns `undefined` for a word that is not the
 * canonical encoding of a key of `keyType`, so `encodeMappingKey` of the
 * result always gives `word` again.
 */
export function decodeMappingKey(
  keyType: StorageType,
  word: Hex.Hex,
): StoragePathSubscript | undefined {
  const valueType = parseValueType(keyType);
  const value = BigInt(word);

  switch (valueType?.kind) {
    case "address":
      return value >> 160n === 0n
        ? { kind: "hex", value: toAddress(value) }
        : undefined;
    case "bool":
      return value === 0n || value === 1n
        ? { kind: "bool", value: value === 1n }
        : undefined;
    case "uint":
    case "int": {
      const key = valueType.kind === "int" ? BigInt.asIntN(256, value) : value;
      const { min, max } = integerRange(valueType);
      return key >= min && key <= max
        ? { kind: "number", value: key }
        : undefined;
    }
    case "fixedBytes": {
      const key = Hex.slice(word, 0, valueType.size);
      return Hex.padRight(key, 32) === word
        ? { kind: "hex", value: key }
        : undefined;
    }
    default:
      return undefined;
  }
}

// --- Composite layout --------------------------------------------------------

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
