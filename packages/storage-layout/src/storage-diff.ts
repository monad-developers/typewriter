import { Hash, Hex } from "ox";
import {
  type ResolvedStorageItem,
  resolveStoragePath,
  type StorageLayout,
  type StoragePathToPrimitiveType,
  type StorageType,
} from "./storage-layout";
import {
  decodeStoragePath,
  encodeStoragePath,
  formatStoragePath,
  normalizePath,
  type StoragePath as ParsedStoragePath,
} from "./storage-path";
import type {
  AccountStorage,
  ConcreteStoragePath,
  SlotWrite,
  SlotWrites,
} from "./types";

export type StorageSlotDiff = {
  readonly pre: AccountStorage;
  readonly post: AccountStorage;
};

export type StorageSlotWriteDiff = {
  readonly pre: SlotWrites;
  readonly post: SlotWrites;
};

type StoragePathDiffValues<Layout extends StorageLayout> =
  string extends Layout["storage"][number]["label"]
    ? Record<string, unknown>
    : Pretty<
        UnionToIntersection<
          ConcreteStoragePath<Layout> extends infer Path extends string
            ? {
                readonly [Key in Path]?: StoragePathToPrimitiveType<
                  Layout,
                  Key
                >;
              }
            : never
        >
      >;

type Pretty<T> = { [K in keyof T]: T[K] } & unknown;

type UnionToIntersection<T> = (
  T extends unknown
    ? (value: T) => void
    : never
) extends (value: infer Intersection) => void
  ? Intersection
  : never;

export type StoragePathDiff<Layout extends StorageLayout = StorageLayout> = {
  readonly pre: StoragePathDiffValues<Layout>;
  readonly post: StoragePathDiffValues<Layout>;
};

const encodeUnknownStoragePath = encodeStoragePath as (
  layout: StorageLayout,
  path: string,
  value: unknown,
) => SlotWrites;

const decodeUnknownStoragePath = decodeStoragePath as (
  layout: StorageLayout,
  path: string,
  storage: AccountStorage,
) => unknown;

export function encodeStorageDiff<const Layout extends StorageLayout>(
  layout: Layout,
  storagePathDiff: StoragePathDiff<Layout>,
): StorageSlotWriteDiff;
export function encodeStorageDiff(
  layout: StorageLayout,
  storagePathDiff: StoragePathDiff,
): StorageSlotWriteDiff {
  return {
    pre: encodeStoragePathDiffValues(layout, storagePathDiff.pre),
    post: encodeStoragePathDiffValues(layout, storagePathDiff.post),
  };
}

export function decodeStorageDiff<const Layout extends StorageLayout>(
  layout: Layout,
  storageSlotDiff: StorageSlotDiff,
  knownPaths?: readonly ConcreteStoragePath<Layout>[],
): StoragePathDiff<Layout>;
export function decodeStorageDiff(
  layout: StorageLayout,
  storageSlotDiff: StorageSlotDiff,
  knownPaths?: readonly string[],
): StoragePathDiff {
  return decodeStorageSlotDiff(layout, storageSlotDiff, knownPaths);
}

function encodeStoragePathDiffValues(
  layout: StorageLayout,
  pathValues: StoragePathDiffValues<StorageLayout>,
): SlotWrites {
  const writes: SlotWrites = {};
  for (const [path, value] of Object.entries(pathValues)) {
    mergeSlotWrites(writes, encodeUnknownStoragePath(layout, path, value));
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

function decodeStorageSlotDiff(
  layout: StorageLayout,
  diff: StorageSlotDiff,
  knownPaths?: readonly string[],
): StoragePathDiff {
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
  const pathDiff: StoragePathDiff = { pre: {}, post: {} };

  for (const slot of diffSlots(diff)) {
    const matchedPaths = findConcretePathsForSlot(layout, slot, knownPathSlots);
    for (const path of matchedPaths) {
      consumedSlots.add(slot.toLowerCase());
      const preValue = decodeUnknownStoragePath(
        layout,
        path,
        storageWithDefault(preStorage, slot),
      );
      const postValue = decodeUnknownStoragePath(
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

function collectConcreteStaticPaths(
  layout: StorageLayout,
): ParsedStoragePath[] {
  const paths: ParsedStoragePath[] = [];
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
  path: ParsedStoragePath,
  paths: ParsedStoragePath[],
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

function normalizeSlotWrite(write: SlotWrite): SlotWrite {
  return {
    value: normalizeSlotValue(write.value),
    mask: normalizeSlotValue(write.mask),
  };
}

function normalizeSlot(slot: Hex.Hex): Hex.Hex {
  return Hex.fromNumber(BigInt(slot), { size: 32 });
}

function normalizeSlotValue(value: Hex.Hex): Hex.Hex {
  return Hex.fromNumber(BigInt(value), { size: 32 });
}

function storageSlot(resolved: ResolvedStorageItem): Hex.Hex {
  return Hex.fromNumber(resolved.baseSlot + BigInt(resolved.item.slot), {
    size: 32,
  });
}

function findStorageType(layout: StorageLayout, typeId: string): StorageType {
  const type = layout.types[typeId];
  if (type === undefined) {
    throw new Error(`storage type not found: ${typeId}`);
  }
  return type;
}

function fixedArrayLength(type: StorageType): number {
  const match = /\[([0-9]+)\]$/.exec(type.label);
  if (match === null) {
    throw new Error(`fixed array type '${type.label}' is missing length`);
  }
  return Number(match[1]);
}
