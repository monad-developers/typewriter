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
  KeccakPreimages,
  MappingEntryVariable,
  MappingStorageVariable,
} from "./types";

/**
 * List the entries of a mapping whose keys appear in captured keccak256
 * preimages. Storage does not record mapping keys, so a key is listed only if
 * a 64-byte preimage hashes it with the mapping's slot, even if its value is
 * now zero. Other preimages are ignored.
 *
 * Known limits: an optimized contract hashes a constant key, such as `m[1]`,
 * at compile time, so no preimage for it is captured. Mappings with `bytes` or
 * `string` keys are not supported.
 *
 * @param layout - Solidity compiler `storageLayout` output.
 * @param mapping - Selector of a mapping, for example `allowances[0x…]`.
 * @param preimages - keccak256 preimages captured during execution, as
 * lowercase hex.
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
  preimages: KeccakPreimages,
): NoInfer<MappingEntryVariable<layout, mapping>[]> {
  const { type, slot, selector } = resolveStoragePath(
    layout,
    mapping as unknown as string,
  );
  if (isMappingType(type) === false) {
    throw new Error(`storage path is not a mapping: ${selector}`);
  }
  const keys = mappingKeys(findStorageType(layout, type.key), slot, preimages);
  return Array.from(
    keys.keys(),
    (key) => `${selector}[${key}]`,
  ) as unknown as MappingEntryVariable<layout, mapping>[];
}

/**
 * Keys of the mapping at `mappingSlot` in `preimages`, in order, once each,
 * keyed by their selector text.
 */
export function mappingKeys(
  keyType: StorageType,
  mappingSlot: bigint,
  preimages: KeccakPreimages,
): Map<string, StoragePathSubscript> {
  const slotDigits = toWord(mappingSlot).slice(2);
  const keys = new Map<string, StoragePathSubscript>();
  for (const preimage of preimages) {
    if (preimage.length !== PAIR_LENGTH) continue;
    if (preimage.endsWith(slotDigits) === false) continue;

    const keyWord = preimage.slice(0, KEY_END) as Hex.Hex;
    // `hasMappingKey` matches exact text, so skip what it cannot find.
    if (keyWord !== keyWord.toLowerCase()) continue;
    const key = decodeMappingKey(keyType, keyWord);
    if (key !== undefined) keys.set(formatSubscript(key), key);
  }
  return keys;
}

/** Whether a preimage hashes `key` with the mapping at `mappingSlot`. */
export function hasMappingKey(
  keyType: StorageType,
  mappingSlot: bigint,
  key: StoragePathSubscript,
  preimages: KeccakPreimages,
): boolean {
  let keyWord: Hex.Hex;
  try {
    keyWord = encodeMappingKey(keyType, key, formatSubscript(key));
  } catch {
    return false; // Not a valid key for this key type.
  }
  return preimages.has(
    Hex.concat(keyWord, toWord(mappingSlot)).toLowerCase() as Hex.Hex,
  );
}

/** Length of a 64-byte preimage as hex text: `0x`, key word, slot word. */
const PAIR_LENGTH = 130;
/** End of the key word in a 64-byte preimage, as a string index. */
const KEY_END = 66;
