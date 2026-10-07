import { Hex } from "ox";
import {
  decodeMappingKey,
  encodeMappingKey,
  toWord,
} from "./solidity-encoding";
import {
  findStorageType,
  isMappingType,
  resolveStoragePath,
  type StorageLayout,
  type StorageType,
} from "./storage-layout";
import { formatSubscript, type StoragePathSubscript } from "./storage-path";
import type {
  KeccakPreimage,
  MappingEntryVariable,
  MappingStorageVariable,
} from "./types";

/**
 * List the entries of a mapping whose keys appear in captured keccak256
 * preimages. Storage does not record mapping keys, so a key is listed only if
 * a 64-byte preimage hashes it with the mapping's slot, even if its value is
 * now zero. Other preimages are ignored, and `hash` is not checked.
 *
 * @param layout - Solidity compiler `storageLayout` output.
 * @param mapping - Selector of a mapping, for example `allowances[0x…]`.
 * @param preimages - keccak256 preimages captured during execution.
 * @returns One selector per known key, for example `allowances[0x…][0x…]`, in
 * preimage order without duplicates.
 *
 * @example
 * ```ts
 * enumerateMappingKeys(layout, "balances", preimages);
 * // ["balances[0x1111…]", "balances[0x2222…]"]
 * ```
 */
export function enumerateMappingKeys<
  const layout extends StorageLayout,
  mapping extends MappingStorageVariable<layout>,
>(
  layout: layout,
  mapping: mapping,
  preimages: readonly KeccakPreimage[],
): NoInfer<MappingEntryVariable<layout, mapping>[]> {
  const { type, slot, selector } = resolveStoragePath(
    layout,
    mapping as unknown as string,
  );
  if (isMappingType(type) === false) {
    throw new Error(`storage path is not a mapping: ${selector}`);
  }
  const keys = mappingKeys(findStorageType(layout, type.key), slot, preimages);
  return keys.map(
    (key) => `${selector}[${formatSubscript(key)}]`,
  ) as unknown as MappingEntryVariable<layout, mapping>[];
}

/** Keys of the mapping at `mappingSlot` in `preimages`, in order, once each. */
export function mappingKeys(
  keyType: StorageType,
  mappingSlot: bigint,
  preimages: readonly KeccakPreimage[],
): StoragePathSubscript[] {
  const keys = new Map<string, StoragePathSubscript>();
  for (const { preimage } of preimages) {
    if (Hex.size(preimage) !== 64) continue;
    if (BigInt(Hex.slice(preimage, 32, 64)) !== mappingSlot) continue;

    const key = decodeMappingKey(keyType, Hex.slice(preimage, 0, 32));
    if (key !== undefined) keys.set(formatSubscript(key), key);
  }
  return [...keys.values()];
}

/** Whether a preimage hashes `key` with the mapping at `mappingSlot`. */
export function hasMappingKey(
  keyType: StorageType,
  mappingSlot: bigint,
  key: StoragePathSubscript,
  preimages: readonly KeccakPreimage[],
): boolean {
  let keyWord: Hex.Hex;
  try {
    keyWord = encodeMappingKey(keyType, key, formatSubscript(key));
  } catch {
    return false; // Not a valid key for this key type.
  }
  const expected = Hex.concat(keyWord, toWord(mappingSlot)).toLowerCase();
  return preimages.some(
    ({ preimage }) =>
      preimage.length === expected.length &&
      preimage.toLowerCase() === expected,
  );
}
