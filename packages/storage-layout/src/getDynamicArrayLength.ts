import { createSlotReader } from "./account-storage";
import {
  isDynamicArrayType,
  resolveStoragePath,
  type StorageLayout,
  type StorageLocation,
} from "./storage-layout";
import type { AccountStorage, DynamicArrayStorageVariable } from "./types";

/**
 * Read the length of a dynamic array from raw account storage. `storage` must
 * contain the array's own slot, which holds the length.
 *
 * @param layout - Solidity compiler `storageLayout` output.
 * @param array - Selector of a dynamic array, for example `numbers`.
 * @param storage - Raw account storage keyed by slot.
 * @returns The number of elements.
 * @throws If `array` is not a dynamic array, if `storage` does not contain the
 * length slot, or if the length is larger than `Number.MAX_SAFE_INTEGER`.
 *
 * @example
 * ```ts
 * getDynamicArrayLength(layout, "numbers", { "0x4": "0x2" }); // 2
 * ```
 */
export function getDynamicArrayLength<
  const layout extends StorageLayout,
  array extends DynamicArrayStorageVariable<layout>,
>(layout: layout, array: array, storage: AccountStorage): number {
  return decodeDynamicArrayLength(
    resolveStoragePath(layout, array as unknown as string),
    storage,
  );
}

/** Read the length of the dynamic array at `location` from raw storage. */
export function decodeDynamicArrayLength(
  { type, slot, selector }: StorageLocation,
  storage: AccountStorage,
): number {
  if (isDynamicArrayType(type) === false) {
    throw new Error(`storage path is not a dynamic array: ${selector}`);
  }
  const length = createSlotReader(storage)(slot);
  if (length > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(
      `dynamic array length ${length} is larger than Number.MAX_SAFE_INTEGER: ${selector}`,
    );
  }
  return Number(length);
}
