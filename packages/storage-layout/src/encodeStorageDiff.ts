import { Hex } from "ox";
import { encodeStorageVariable } from "./encodeStorageVariable";
import type { StorageSlotWriteDiff, StorageVariableDiff } from "./storage-diff";
import type { StorageLayout } from "./storage-layout";
import { normalizeSlot, normalizeSlotValue } from "./storage-variable";
import type { SlotWrite, SlotWrites } from "./types";

const encodeUnknownStorageVariable = encodeStorageVariable as (
  layout: StorageLayout,
  path: string,
  value: unknown,
) => SlotWrites;

export function encodeStorageDiff<const layout extends StorageLayout>(
  layout: layout,
  storageVariableDiff: StorageVariableDiff<layout>,
): StorageSlotWriteDiff;
export function encodeStorageDiff(
  layout: StorageLayout,
  storageVariableDiff: StorageVariableDiff,
): StorageSlotWriteDiff {
  return {
    pre: encodeStorageVariableDiffValues(layout, storageVariableDiff.pre),
    post: encodeStorageVariableDiffValues(layout, storageVariableDiff.post),
  };
}

function encodeStorageVariableDiffValues(
  layout: StorageLayout,
  pathValues: Record<string, unknown>,
): SlotWrites {
  const writes: SlotWrites = {};
  for (const [path, value] of Object.entries(pathValues)) {
    mergeSlotWrites(writes, encodeUnknownStorageVariable(layout, path, value));
  }
  return writes;
}

function mergeSlotWrites(target: SlotWrites, writes: SlotWrites): void {
  for (const [slot, write] of Object.entries(writes)) {
    const normalizedSlot = normalizeSlot(slot as Hex.Hex);
    const existing = target[normalizedSlot];
    target[normalizedSlot] =
      existing === undefined
        ? normalizeSlotWrite(write)
        : mergeSlotWrite(existing, write);
  }
}

function mergeSlotWrite(left: SlotWrite, right: SlotWrite): SlotWrite {
  const leftValue = BigInt(left.value);
  const leftMask = BigInt(left.mask);
  const rightValue = BigInt(right.value);
  const rightMask = BigInt(right.mask);
  const overlap = leftMask & rightMask;
  if (overlap !== 0n && (leftValue & overlap) !== (rightValue & overlap)) {
    throw new Error(
      "conflicting storage diff writes for overlapping slot masks",
    );
  }
  return {
    value: Hex.fromNumber((leftValue & ~rightMask) | (rightValue & rightMask), {
      size: 32,
    }),
    mask: Hex.fromNumber(leftMask | rightMask, { size: 32 }),
  };
}

function normalizeSlotWrite(write: SlotWrite): SlotWrite {
  return {
    value: normalizeSlotValue(write.value),
    mask: normalizeSlotValue(write.mask),
  };
}
