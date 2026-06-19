import { Hex } from "ox";
import type { SlotWrite } from "./types";

export type { StorageProxy } from "./createStorageProxy";
export { createStorageProxy } from "./createStorageProxy";
export { decodeStorageDiff } from "./decodeStorageDiff";
export { decodeStorageVariable } from "./decodeStorageVariable";
export { encodeStorageDiff } from "./encodeStorageDiff";
export { encodeStorageVariable } from "./encodeStorageVariable";
export { getStorageSlot } from "./getStorageSlot";
export { getStorageVariable } from "./getStorageVariable";
export {
  type KeccakPreimage,
  recoverStoragePaths,
} from "./recover-storage-paths";
export type {
  StorageSlotDiff,
  StorageSlotWriteDiff,
  StorageVariableDiff,
} from "./storage-diff";
export type {
  ExtractVariableNames,
  StorageLayout,
  StorageLayoutToPrimitiveType,
  StorageType,
  StorageVariableToPrimitiveType,
} from "./storage-layout";
export type {
  AccountStorage,
  ConcreteStorageVariable,
  SlotWrite,
  SlotWrites,
  StorageVariable,
} from "./types";

/** Apply a masked slot write to an existing 32-byte storage slot value. */
export function applySlotWrite(
  slotWrite: SlotWrite,
  existingSlot: Hex.Hex,
): Hex.Hex {
  const mask = BigInt(slotWrite.mask);
  const next =
    (BigInt(existingSlot) & ~mask) | (BigInt(slotWrite.value) & mask);
  return Hex.fromNumber(next, { size: 32 });
}
