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
import {
  formatStoragePath,
  formatSubscript,
  parseStoragePath,
  type StoragePathSubscript,
} from "./storage-path";
import type {
  KeccakPreimage,
  MappingEntryVariable,
  MappingStorageVariable,
} from "./types";

/**
 * List the known entries of a mapping, from captured keccak256 preimages.
 *
 * Solidity stores the value for `key` at `keccak256(key . mappingSlot)`, and
 * storage does not record which keys exist. A key is known only if a captured
 * 64-byte preimage hashes it with this mapping's slot. So the result is every
 * key that the captured executions accessed (read or written), including keys
 * whose value is now zero. A key that no captured execution hashed is not
 * listed.
 *
 * Preimages that are not 64 bytes, that belong to another mapping, or whose key
 * word is not a canonical encoding of the mapping's key type are ignored.
 * `hash` is not used, so it is not checked.
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
): MappingEntryVariable<layout, mapping>[] {
  const path = parseStoragePath(mapping);
  const { type, slot } = resolveStoragePath(layout, path);
  if (isMappingType(type) === false) {
    throw new Error(
      `storage path is not a mapping: ${formatStoragePath(path)}`,
    );
  }
  const keys = mappingKeys(findStorageType(layout, type.key), slot, preimages);
  return keys.map((key) =>
    formatStoragePath({
      root: path.root,
      segments: [...path.segments, { kind: "subscript", value: key }],
    }),
  ) as MappingEntryVariable<layout, mapping>[];
}

/**
 * The keys of the mapping at `mappingSlot` that the 64-byte preimages hash, in
 * preimage order without duplicates. Key words that are not a canonical
 * encoding of the key type are skipped.
 */
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

/**
 * Whether a preimage hashes `key` with the mapping at `mappingSlot`. This
 * encodes the expected preimage one time and compares strings, so it does not
 * decode the other preimages.
 */
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
