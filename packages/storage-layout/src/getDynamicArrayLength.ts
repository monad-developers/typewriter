import { createSlotReader } from "./account-storage";
import {
  isDynamicArrayType,
  resolveStoragePath,
  type StorageLayout,
} from "./storage-layout";
import { formatStoragePath, parseStoragePath } from "./storage-path";
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
  const path = parseStoragePath(array as unknown as string);
  const { type, slot } = resolveStoragePath(layout, path);
  if (isDynamicArrayType(type) === false) {
    throw new Error(
      `storage path is not a dynamic array: ${formatStoragePath(path)}`,
    );
  }

  const length = createSlotReader(storage)(slot);
  if (length > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(
      `dynamic array length ${length} is larger than Number.MAX_SAFE_INTEGER: ${formatStoragePath(path)}`,
    );
  }
  return Number(length);
}
