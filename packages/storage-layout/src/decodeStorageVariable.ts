import { Address, Hex } from "ox";
import { createSlotReader } from "./account-storage";
import { keccakSlot, parseValueType, toWord } from "./solidity-encoding";
import {
  isMappingType,
  resolveStoragePath,
  type StorageLayout,
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
): NoInfer<StorageVariableToPrimitiveType<layout, variable>> {
  const path = parseStoragePath(variable as unknown as string);
  const selector = formatStoragePath(path);
  const { type, slot, offset } = resolveStoragePath(layout, path);
  assertConcreteType(type, selector);
  const readSlot = createSlotReader(storage);

  if (type.encoding === "bytes") {
    const root = readSlot(slot);
    const { length, dataSlots } = bytesLength(slot, root, selector);
    const data =
      dataSlots.length === 0
        ? toWord(root)
        : Hex.concat(
            ...dataSlots.map((dataSlot) => toWord(readSlot(dataSlot))),
          );
    const bytes = Hex.slice(data, 0, length);
    return (type.label === "string" ? Hex.toString(bytes) : bytes) as never;
  }

  const valueType = parseValueType(type)!;
  const bits = BigInt(Number(type.numberOfBytes) * 8);
  const field = (readSlot(slot) >> BigInt(offset * 8)) & ((1n << bits) - 1n);
  switch (valueType.kind) {
    case "address":
      return Address.checksum(Hex.fromNumber(field, { size: 20 })) as never;
    case "bool":
      return (field !== 0n) as never;
    case "enum":
      return Number(field) as never;
    case "fixedBytes":
      return Hex.fromNumber(field, { size: valueType.size }) as never;
    case "uint":
    case "int": {
      const value =
        valueType.kind === "int" ? BigInt.asIntN(valueType.bits, field) : field;
      // Like abitype, integers of 48 bits or fewer are `number`.
      return (valueType.bits <= 48 ? Number(value) : value) as never;
    }
  }
}

/** Throw unless `type` is a value type, `bytes`, or `string`. */
export function assertConcreteType(type: StorageType, path: string): void {
  if (type.encoding === "bytes" || parseValueType(type) !== undefined) return;
  if (isMappingType(type)) {
    throw new Error(`mapping storage paths require a key: ${path}`);
  }
  if (
    type.encoding === "dynamic_array" ||
    type.members !== undefined ||
    type.base !== undefined
  ) {
    throw new Error(`storage path does not point to a leaf value: ${path}`);
  }
  throw new Error(`unsupported storage path type '${type.label}' for ${path}`);
}

/**
 * The largest `bytes`/`string` value to decode: 2^19 data slots, more than any
 * block gas limit allows a contract to write. A corrupt root word could
 * otherwise ask for 2^250 slots.
 */
export const MAX_BYTES_LENGTH = 2 ** 24;

/**
 * Length and data slots of a `bytes`/`string` value from its root word.
 *
 * Below 32 bytes, the value is in the root slot with `length * 2` in the
 * lowest byte, and there are no data slots. Otherwise the root holds
 * `length * 2 + 1` and the data starts at `keccak256(rootSlot)`. A root word
 * whose form does not agree with its length throws, like Solidity's panic
 * `0x22`.
 */
export function bytesLength(
  rootSlot: bigint,
  rootWord: bigint,
  path: string,
): { length: number; dataSlots: bigint[] } {
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
  if (long === false) return { length: Number(length), dataSlots: [] };
  const dataSlot = keccakSlot(rootSlot);
  return {
    length: Number(length),
    dataSlots: Array.from(
      { length: Math.ceil(Number(length) / 32) },
      (_, index) => dataSlot + BigInt(index),
    ),
  };
}
