import { Hex } from "ox";
import { createSlotReader, type SlotReader } from "./account-storage";
import {
  keccakSlot,
  parseValueType,
  toAddress,
  toWord,
  type ValueType,
} from "./solidity-encoding";
import {
  isMappingType,
  resolveStoragePath,
  type StorageLayout,
  type StorageLocation,
  type StorageType,
} from "./storage-layout";
import { formatStoragePath, parseStoragePath } from "./storage-path";
import type {
  AccountStorage,
  ConcreteStorageVariable,
  StorageVariableToPrimitiveType,
} from "./types";

/**
 * Decode one concrete storage variable from raw account storage.
 *
 * `storage` must contain every slot that the value occupies: the slot of a
 * value type, or the root slot of a `bytes`/`string` value. A `bytes`/`string`
 * value of 32 bytes or more also needs each data slot at `keccak256(root) + i`.
 * Slot keys can be in any hex form, for example `0x0` or a 32-byte word.
 *
 * @param layout - Solidity compiler `storageLayout` output.
 * @param variable - Storage variable selector, for example `balances[0x…]`.
 * @param storage - Raw account storage keyed by slot.
 * @returns The decoded value, typed from the layout.
 * @throws If `variable` does not select one concrete value, if a type is not
 * supported, or if `storage` does not contain a required slot.
 *
 * @example
 * ```ts
 * const supply = decodeStorageVariable(layout, "totalSupply", {
 *   "0x0": "0x2a",
 * }); // 42n
 * ```
 */
export function decodeStorageVariable<
  const layout extends StorageLayout,
  variable extends ConcreteStorageVariable<layout>,
>(
  layout: layout,
  variable: variable,
  storage: AccountStorage,
): StorageVariableToPrimitiveType<layout, variable> {
  const path = parseStoragePath(variable);
  const location = resolveStoragePath(layout, path);
  const readSlot = createSlotReader(storage);

  if (location.type.encoding === "bytes") {
    return decodeBytes(
      location,
      readSlot,
      formatStoragePath(path),
    ) as StorageVariableToPrimitiveType<layout, variable>;
  }
  const valueType = parseValueType(location.type);
  if (valueType === undefined) {
    throw new Error(notConcreteMessage(location.type, formatStoragePath(path)));
  }
  return decodeValue(
    valueType,
    extractField(readSlot(location.slot), location),
  ) as StorageVariableToPrimitiveType<layout, variable>;
}

function notConcreteMessage(type: StorageType, path: string): string {
  if (isMappingType(type)) {
    return `mapping storage paths require a key: ${path}`;
  }
  if (
    type.encoding === "dynamic_array" ||
    type.members !== undefined ||
    type.base !== undefined
  ) {
    return `storage path does not point to a leaf value: ${path}`;
  }
  return `unsupported storage path type '${type.label}' for ${path}`;
}

/** The `numberOfBytes` bytes of `word` that start `offset` bytes from its low end. */
function extractField(word: bigint, location: StorageLocation): bigint {
  const bits = BigInt(Number(location.type.numberOfBytes) * 8);
  return (word >> BigInt(location.offset * 8)) & ((1n << bits) - 1n);
}

function decodeValue(valueType: ValueType, field: bigint) {
  switch (valueType.kind) {
    case "address":
      return toAddress(field);
    case "bool":
      return field !== 0n;
    case "enum":
      return Number(field);
    case "fixedBytes":
      return Hex.fromNumber(field, { size: valueType.size });
    case "uint":
    case "int": {
      const value =
        valueType.kind === "int" ? BigInt.asIntN(valueType.bits, field) : field;
      // abitype maps integers of 48 bits or fewer to `number`.
      return valueType.bits <= 48 ? Number(value) : value;
    }
  }
}

/**
 * Decode a `bytes` or `string` value from its root slot and, for a value of 32
 * bytes or more, its data slots.
 */
function decodeBytes(
  location: StorageLocation,
  readSlot: SlotReader,
  path: string,
): Hex.Hex | string {
  const root = readSlot(location.slot);
  const { length } = bytesLength(root, path);
  const dataSlots = bytesDataSlots(location.slot, root, path);
  const bytes =
    dataSlots.length === 0
      ? Hex.slice(toWord(root), 0, length)
      : Hex.slice(
          Hex.concat(...dataSlots.map((slot) => toWord(readSlot(slot)))),
          0,
          length,
        );

  return location.type.label === "string" ? Hex.toString(bytes) : bytes;
}

/**
 * The largest `bytes`/`string` value to decode, in bytes. This is 2^19 data
 * slots, far more than a contract can write under any block gas limit. It
 * stops a corrupt or wrong root word from making a read of 2^250 slots.
 */
export const MAX_BYTES_LENGTH = 2 ** 24;

/**
 * Byte length of a `bytes`/`string` value from the word in its root slot.
 *
 * A value shorter than 32 bytes is stored in the high-order bytes of the root
 * slot, with `length * 2` in the lowest byte. A longer value stores
 * `length * 2 + 1` in the root slot and its data in consecutive slots from
 * `keccak256(root)`. Like Solidity (panic `0x22`), this rejects a root word
 * whose form does not agree with its length.
 */
function bytesLength(
  rootWord: bigint,
  path: string,
): { length: number; long: boolean } {
  const long = (rootWord & 1n) === 1n;
  const length = long ? rootWord >> 1n : (rootWord & 0xffn) >> 1n;
  if (long !== length >= 32n) {
    throw new Error(`incorrectly encoded bytes length slot: ${path}`);
  }
  if (length > BigInt(MAX_BYTES_LENGTH)) {
    throw new Error(
      `bytes value of ${length} bytes is larger than the ${MAX_BYTES_LENGTH}-byte limit: ${path}`,
    );
  }
  return { length: Number(length), long };
}

/**
 * The data slots of a `bytes`/`string` value, from its root slot and the word
 * stored there. A short value has no data slots.
 *
 * @throws If the root word is not a valid length, or the value is larger than
 * {@link MAX_BYTES_LENGTH}.
 */
export function bytesDataSlots(
  rootSlot: bigint,
  rootWord: bigint,
  path: string,
): bigint[] {
  const { length, long } = bytesLength(rootWord, path);
  if (long === false) return [];
  const dataSlot = keccakSlot(rootSlot);
  return Array.from(
    { length: Math.ceil(length / 32) },
    (_, index) => dataSlot + BigInt(index),
  );
}
