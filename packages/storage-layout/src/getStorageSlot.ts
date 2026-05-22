import { Hex } from "ox";
import {
  type ExtractStorageVariables,
  type ResolvedStorageItem,
  resolveStoragePath,
  type StorageLayout,
} from "./storage-layout";
import { normalizePath } from "./storage-path";

/**
 * Computes the EVM storage slots for a storage variable.
 *
 * The result is always an array of unique slots in layout order.
 *
 * Dynamic array roots resolve to their length slot. Indexed dynamic-array
 * variables resolve to element slot(s).
 *
 * @param storageLayout - Solidity compiler `storageLayout` output.
 * @param storageVariable - Solidity storage variable selector.
 */
export function getStorageSlot<
  const layout extends StorageLayout,
  variable extends ExtractStorageVariables<layout>,
>(storageLayout: layout, storageVariable: variable): Hex.Hex[] {
  const seen = new Set<string>();
  const slots: Hex.Hex[] = [];
  for (const resolved of resolveStoragePath(
    storageLayout,
    normalizePath(storageVariable as string),
  )) {
    const slot = storageSlot(resolved);
    const key = slot.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    slots.push(slot);
  }
  return slots;
}

function storageSlot(resolved: ResolvedStorageItem): Hex.Hex {
  return Hex.fromNumber(resolved.baseSlot + BigInt(resolved.item.slot), {
    size: 32,
  });
}
