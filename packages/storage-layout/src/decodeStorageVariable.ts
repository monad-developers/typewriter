import { Address, Hex } from "ox";
import { createSlotReader } from "./account-storage";
import { keccakSlot, parseValueType, toWord } from "./solidity-encoding";
import {
  isMappingType,
  resolveStoragePath,
  type StorageLayout,
  type StorageLocation,
} from "./storage-layout";
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
  return decodeStorageLocation(
    resolveStoragePath(layout, variable as unknown as string),
    storage,
  ) as never;
}

/** Decode the concrete value at `location` from raw account storage. */
export function decodeStorageLocation(
  location: StorageLocation,
  storage: AccountStorage,
): unknown {
  assertConcreteType(location);
  const { type, slot, offset } = location;
  const readSlot = createSlotReader(storage);

  if (type.encoding === "bytes") {
    const root = readSlot(slot);
    const { length, dataSlots } = bytesLength(location, root);
    const data =
      dataSlots.length === 0
        ? toWord(root)
        : Hex.concat(
            ...dataSlots.map((dataSlot) => toWord(readSlot(dataSlot))),
          );
    const bytes = Hex.slice(data, 0, length);
    return type.label === "string" ? Hex.toString(bytes) : bytes;
  }

  const valueType = parseValueType(type)!;
  const bits = BigInt(Number(type.numberOfBytes) * 8);
  const field = (readSlot(slot) >> BigInt(offset * 8)) & ((1n << bits) - 1n);
  switch (valueType.kind) {
    case "address":
      return Address.checksum(Hex.fromNumber(field, { size: 20 }));
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
      // Like abitype, integers of 48 bits or fewer are `number`.
      return valueType.bits <= 48 ? Number(value) : value;
    }
  }
}

/** Throw unless `location` holds a value type, `bytes`, or `string`. */
export function assertConcreteType({ type, selector }: StorageLocation) {
  if (type.encoding === "bytes" || parseValueType(type) !== undefined) return;
  if (isMappingType(type)) {
    throw new Error(`mapping storage paths require a key: ${selector}`);
  }
  if (
    type.encoding === "dynamic_array" ||
    type.members !== undefined ||
    type.base !== undefined
  ) {
    throw new Error(`storage path does not point to a leaf value: ${selector}`);
  }
  throw new Error(
    `unsupported storage path type '${type.label}' for ${selector}`,
  );
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
function bytesLength(
  { slot, selector }: StorageLocation,
  rootWord: bigint,
): { length: number; dataSlots: bigint[] } {
  const long = (rootWord & 1n) === 1n;
  const length = long ? rootWord >> 1n : (rootWord & 0xffn) >> 1n;
  if (long !== length >= 32n) {
    throw new Error(`incorrectly encoded bytes length slot: ${selector}`);
  }
  if (length > BigInt(MAX_BYTES_LENGTH)) {
    throw new Error(
      `bytes value of ${length} bytes is larger than the ${MAX_BYTES_LENGTH}-byte limit: ${selector}`,
    );
  }
  if (long === false) return { length: Number(length), dataSlots: [] };
  const dataSlot = keccakSlot(slot);
  return {
    length: Number(length),
    dataSlots: Array.from(
      { length: Math.ceil(Number(length) / 32) },
      (_, index) => dataSlot + BigInt(index),
    ),
  };
}

/**
 * Data slots that `location` needs besides its own slot: those of a long
 * `bytes`/`string` value, from its root word in `storage`, or none.
 */
export function bytesDataSlots(
  location: StorageLocation,
  storage: AccountStorage,
): bigint[] {
  if (location.type.encoding !== "bytes") return [];
  return bytesLength(location, createSlotReader(storage)(location.slot))
    .dataSlots;
}
