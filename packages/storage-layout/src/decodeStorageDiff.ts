import { Hash, Hex } from "ox";
import { decodeStorageVariable } from "./decodeStorageVariable";
import type { StorageSlotDiff, StorageVariableDiff } from "./storage-diff";
import {
  findStorageType,
  fixedArrayLength,
  resolveStoragePath,
  type StorageLayout,
  type StorageType,
} from "./storage-layout";
import {
  formatStoragePath,
  normalizePath,
  type StoragePath,
} from "./storage-path";
import {
  normalizeSlot,
  normalizeSlotValue,
  storageSlot,
} from "./storage-variable";
import type { AccountStorage, ConcreteStorageVariable } from "./types";

const decodeUnknownStorageVariable = decodeStorageVariable as (
  layout: StorageLayout,
  path: string,
  storage: AccountStorage,
) => unknown;

export function decodeStorageDiff<const layout extends StorageLayout>(
  layout: layout,
  storageSlotDiff: StorageSlotDiff,
  knownVariables?: readonly ConcreteStorageVariable<layout>[],
): StorageVariableDiff<layout>;
export function decodeStorageDiff(
  layout: StorageLayout,
  storageSlotDiff: StorageSlotDiff,
  knownVariables?: readonly string[],
): StorageVariableDiff {
  return decodeStorageSlotDiff(layout, storageSlotDiff, knownVariables);
}

function decodeStorageSlotDiff(
  layout: StorageLayout,
  diff: StorageSlotDiff,
  knownPaths?: readonly string[],
): StorageVariableDiff {
  const preStorage = normalizeStorage(diff.pre);
  const postStorage = normalizeStorage(diff.post);
  const knownPathSlots = knownPaths?.map((path) => {
    const resolved = resolveStoragePath(layout, normalizePath(path));
    const [item] = resolved;
    if (item === undefined || resolved.length !== 1) {
      throw new Error(`storage path does not point to a leaf value: ${path}`);
    }
    return { path, slot: storageSlot(item).toLowerCase() };
  });
  const consumedSlots = new Set<string>();
  const pathDiff: StorageVariableDiff = { pre: {}, post: {} };

  for (const slot of diffSlots(diff)) {
    const matchedPaths = findConcretePathsForSlot(layout, slot, knownPathSlots);
    for (const path of matchedPaths) {
      consumedSlots.add(slot.toLowerCase());
      const preValue = decodeUnknownStorageVariable(
        layout,
        path,
        storageWithDefault(preStorage, slot),
      );
      const postValue = decodeUnknownStorageVariable(
        layout,
        path,
        storageWithDefault(postStorage, slot),
      );
      if (storageValuesEqual(preValue, postValue)) {
        continue;
      }
      pathDiff.pre[path] = preValue;
      pathDiff.post[path] = postValue;
      markDynamicBytesSlots(layout, path, preStorage, consumedSlots);
      markDynamicBytesSlots(layout, path, postStorage, consumedSlots);
    }
  }

  for (const slot of diffSlots(diff)) {
    if (!consumedSlots.has(slot.toLowerCase())) {
      throw new Error(
        `storage slot diff cannot be decoded to a concrete storage path: ${slot}`,
      );
    }
  }

  return pathDiff;
}

function findConcretePathsForSlot(
  layout: StorageLayout,
  slot: Hex.Hex,
  knownPathSlots?: readonly { path: string; slot: string }[],
): string[] {
  const matches: string[] = [];
  const seen = new Set<string>();
  for (const path of collectConcreteStaticPaths(layout)) {
    const resolved = resolveStoragePath(layout, path);
    const [item] = resolved;
    if (item === undefined || resolved.length !== 1) {
      continue;
    }
    if (storageSlot(item).toLowerCase() !== slot.toLowerCase()) {
      continue;
    }
    addMatchedPath(matches, seen, formatStoragePath(path));
  }
  if (knownPathSlots !== undefined) {
    for (const knownPath of knownPathSlots) {
      if (knownPath.slot === slot.toLowerCase()) {
        addMatchedPath(matches, seen, knownPath.path);
      }
    }
  }
  return matches;
}

function addMatchedPath(
  matches: string[],
  seen: Set<string>,
  path: string,
): void {
  if (seen.has(path)) {
    return;
  }
  seen.add(path);
  matches.push(path);
}

function collectConcreteStaticPaths(layout: StorageLayout): StoragePath[] {
  const paths: StoragePath[] = [];
  for (const item of layout.storage) {
    collectConcreteStaticTypePaths(
      layout,
      findStorageType(layout, item.type),
      { root: item.label, segments: [] },
      paths,
    );
  }
  return paths;
}

function collectConcreteStaticTypePaths(
  layout: StorageLayout,
  type: StorageType,
  path: StoragePath,
  paths: StoragePath[],
): void {
  if (type.encoding === "mapping" || type.encoding === "dynamic_array") {
    return;
  }
  if (type.members !== undefined) {
    for (const member of type.members) {
      collectConcreteStaticTypePaths(
        layout,
        findStorageType(layout, member.type),
        {
          root: path.root,
          segments: [...path.segments, { kind: "field", name: member.label }],
        },
        paths,
      );
    }
    return;
  }
  if (type.encoding === "inplace" && type.base !== undefined) {
    const baseType = findStorageType(layout, type.base);
    for (let index = 0; index < fixedArrayLength(type); index++) {
      collectConcreteStaticTypePaths(
        layout,
        baseType,
        {
          root: path.root,
          segments: [
            ...path.segments,
            {
              kind: "subscript",
              value: { kind: "number", value: BigInt(index) },
            },
          ],
        },
        paths,
      );
    }
    return;
  }
  paths.push(path);
}

function markDynamicBytesSlots(
  layout: StorageLayout,
  path: string,
  storage: AccountStorage,
  consumedSlots: Set<string>,
): void {
  const resolved = resolveStoragePath(layout, normalizePath(path));
  const [item] = resolved;
  if (
    item === undefined ||
    resolved.length !== 1 ||
    item.type.encoding !== "bytes"
  ) {
    return;
  }
  const slot = storageSlot(item);
  const value = storage[slot];
  if (value === undefined) {
    return;
  }
  const normalizedValue = normalizeSlotValue(value);
  const marker = Number(BigInt(Hex.slice(normalizedValue, 31, 32)));
  if (marker % 2 === 0) {
    return;
  }
  const length = Number((BigInt(normalizedValue) - 1n) / 2n);
  const baseSlot = BigInt(Hash.keccak256(slot));
  for (let index = 0; index < Math.ceil(length / 32); index++) {
    consumedSlots.add(
      Hex.fromNumber(baseSlot + BigInt(index), { size: 32 }).toLowerCase(),
    );
  }
}

function diffSlots(diff: StorageSlotDiff): Hex.Hex[] {
  const slots: Hex.Hex[] = [];
  const seen = new Set<string>();
  for (const slot of [...Object.keys(diff.pre), ...Object.keys(diff.post)]) {
    const normalizedSlot = normalizeSlot(slot as Hex.Hex);
    const key = normalizedSlot.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    slots.push(normalizedSlot);
  }
  return slots;
}

function normalizeStorage(storage: AccountStorage): AccountStorage {
  const normalized: AccountStorage = {};
  for (const [slot, value] of Object.entries(storage)) {
    normalized[normalizeSlot(slot as Hex.Hex)] = normalizeSlotValue(
      value as Hex.Hex,
    );
  }
  return normalized;
}

function storageWithDefault(
  storage: AccountStorage,
  slot: Hex.Hex,
): AccountStorage {
  if (storage[slot] !== undefined) {
    return storage;
  }
  return { ...storage, [slot]: Hex.fromNumber(0n, { size: 32 }) };
}

function storageValuesEqual(left: unknown, right: unknown): boolean {
  return Object.is(left, right);
}
