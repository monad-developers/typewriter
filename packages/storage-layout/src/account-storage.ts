import type { Hex } from "ox";
import { toWord } from "./solidity-encoding";
import type { AccountStorage } from "./types";

type SlotReader = (slot: bigint) => bigint;

/** Read slot words from `storage`, whose keys can be in any hex form. */
export function createSlotReader(storage: AccountStorage): SlotReader {
  let bySlot: Map<bigint, Hex.Hex> | undefined;

  return (slot) => {
    let value: Hex.Hex | undefined = storage[toWord(slot)];
    if (value === undefined) {
      bySlot ??= indexBySlot(storage);
      value = bySlot.get(slot);
    }
    if (value === undefined) {
      throw new Error(`storage value not found for slot: ${toWord(slot)}`);
    }
    const word = BigInt(value);
    if (word >> 256n !== 0n) {
      throw new Error(`storage value is larger than 32 bytes: ${toWord(slot)}`);
    }
    return word;
  };
}

function indexBySlot(storage: AccountStorage): Map<bigint, Hex.Hex> {
  const bySlot = new Map<bigint, Hex.Hex>();
  for (const [key, value] of Object.entries(storage)) {
    if (/^0x[0-9a-fA-F]+$/.test(key) === false) {
      throw new Error(`storage slot key is not a hex string: ${key}`);
    }
    bySlot.set(BigInt(key), value);
  }
  return bySlot;
}

/** Returns one 32-byte value per slot, in the order of `slots`. */
type SyncStorageGetter = (slots: readonly Hex.Hex[]) => readonly Hex.Hex[];
export type AsyncStorageGetter = (
  slots: readonly Hex.Hex[],
) => Promise<readonly Hex.Hex[]>;
export type StorageGetter = SyncStorageGetter | AsyncStorageGetter;

/** Read `slots` through `getStorage`, each slot once, as account storage. */
export function fetchStorage(
  getStorage: StorageGetter,
  slots: readonly bigint[],
): AccountStorage | Promise<AccountStorage> {
  const words = [...new Set(slots.map(toWord))];
  const toStorage = (values: readonly Hex.Hex[]): AccountStorage => {
    if (values.length !== words.length) {
      throw new Error(
        `getStorage returned ${values.length} values for ${words.length} slots`,
      );
    }
    const storage: AccountStorage = {};
    for (const [index, slot] of words.entries()) {
      const value = values[index];
      if (value === undefined) {
        throw new Error(`getStorage returned no value for slot: ${slot}`);
      }
      storage[slot] = value;
    }
    return storage;
  };
  const values = getStorage(words);
  return values instanceof Promise ? values.then(toStorage) : toStorage(values);
}
