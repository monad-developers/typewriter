import type { Hex } from "ox";
import { toWord } from "./solidity-encoding";
import type { AccountStorage } from "./types";

export type SlotReader = (slot: bigint) => bigint;

/**
 * Read 32-byte slot words from account storage. A slot is looked up by its
 * canonical 32-byte key first. On the first miss, the reader indexes every key
 * by value one time, so keys in any hex form (`0x0`, `0x00`, ...) match.
 */
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
