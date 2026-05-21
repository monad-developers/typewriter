import { Hex } from "ox";
import {
  type ExtractMultiSlotStoragePaths,
  type ExtractStoragePaths,
  type ResolvedStorageItem,
  resolveStoragePath,
  type StorageLayout,
  type StorageLayoutToPrimitiveType,
  type StorageType,
} from "./storage-layout";
import {
  encodeStoragePath,
  formatStoragePath,
  HEX_STRING_PATTERN,
  normalizePath,
  type StoragePath as ParsedStoragePath,
  type StoragePathSubscript,
} from "./storage-path";
import type {
  AccountStorage,
  SlotWrite,
  SlotWrites,
  StoragePath,
} from "./types";

const encodeStoragePathRuntime = encodeStoragePath as (
  layout: StorageLayout,
  path: string,
  value: unknown,
) => SlotWrites;

export type {
  StoragePathDiff,
  StorageSlotDiff,
  StorageSlotWriteDiff,
} from "./storage-diff";
export { decodeStorageDiff, encodeStorageDiff } from "./storage-diff";
export type {
  ExtractVariableNames,
  StorageLayout,
  StorageLayoutToPrimitiveType,
  StoragePathToPrimitiveType,
  StorageType,
} from "./storage-layout";
export {
  decodeStoragePath,
  encodeStoragePath,
  formatStoragePath,
  parseStoragePath,
} from "./storage-path";
export type { StorageProxy } from "./storage-proxy";
export { createStorageProxy } from "./storage-proxy";
export type {
  AccountStorage,
  ConcreteStoragePath,
  SlotWrite,
  SlotWrites,
  StoragePath,
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

/**
 * Compute storage slots for a Solidity storage path.
 *
 * Dynamic array roots resolve to their length slot. Indexed dynamic-array paths
 * resolve to element slot(s).
 *
 * @param layout - Solidity compiler `storageLayout` output.
 * @param pathInput - Human-readable storage path.
 */
export function getStorageSlot<
  const Layout extends StorageLayout,
  Path extends ExtractStoragePaths<Layout>,
>(
  layout: Layout,
  pathInput: Path,
): Path extends ExtractMultiSlotStoragePaths<Layout> ? Hex.Hex[] : Hex.Hex;
export function getStorageSlot(
  layout: StorageLayout,
  pathInput: string,
): Hex.Hex | Hex.Hex[] {
  const slots = uniqueSlots(
    resolveStoragePath(layout, normalizePath(pathInput)),
  );
  return (slots.length === 1 ? slots[0]! : slots) as Hex.Hex | Hex.Hex[];
}

function normalizeConcreteParsedPath(
  layout: StorageLayout,
  path: ParsedStoragePath,
): ParsedStoragePath {
  const resolved = resolveStoragePath(layout, path);
  if (!resolvedPathEndsAtValue(resolved, path)) {
    throw new Error(
      `storage path does not point to a leaf value: ${formatStoragePath(path)}`,
    );
  }
  return path;
}

/**
 * Match raw storage slots back to known Solidity storage paths.
 *
 * @param layout - Solidity compiler `storageLayout` output.
 * @param slot - Changed slot.
 * @param knownPaths - Optional concrete paths used to match irreversible slots such as keyed mappings.
 *
 * @dev Mappings are not reversible from a raw slot alone. When `knownPaths` is omitted, unmatched slots throw if the layout contains mappings instead of silently omitting possible mapping writes.
 */
export function getStoragePath<Layout extends StorageLayout>(
  layout: Layout,
  slot: Hex.Hex,
  knownPaths?: readonly StoragePath<Layout>[],
): StoragePath<Layout>[];
export function getStoragePath(
  layout: StorageLayout,
  slot: Hex.Hex,
  knownPaths?: readonly string[],
): string[] {
  const { slots: layoutSlots, mappingPaths } = collectLayoutSlots(layout);
  const knownSlots = knownPaths?.flatMap((knownPath) =>
    resolveStoragePath(layout, normalizePath(knownPath)),
  );
  const matches: string[] = [];
  const seen = new Set<string>();

  const normalizedSlot = normalizeSlot(slot);
  const matchedLayout = addSlotMatches(
    matches,
    seen,
    layoutSlots,
    normalizedSlot,
  );
  const matchedKnown =
    knownSlots !== undefined &&
    addSlotMatches(matches, seen, knownSlots, normalizedSlot);
  if (!matchedLayout && !matchedKnown && knownPaths === undefined) {
    const [mappingPath] = mappingPaths;
    if (mappingPath !== undefined) {
      throw new Error(mappingPathError(mappingPath));
    }
  }

  return matches;
}

function addSlotMatches(
  matches: string[],
  seen: Set<string>,
  knownSlots: readonly ResolvedStorageItem[],
  normalizedSlot: Hex.Hex,
): boolean {
  let matched = false;
  for (const knownItem of knownSlots) {
    if (storageSlot(knownItem).toLowerCase() !== normalizedSlot.toLowerCase()) {
      continue;
    }
    matched = true;
    const key = formatStoragePath(knownItem.path);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    matches.push(formatStoragePath(knownItem.path));
  }
  return matched;
}

function collectLayoutSlots(layout: StorageLayout): {
  slots: ResolvedStorageItem[];
  mappingPaths: ParsedStoragePath[];
} {
  const paths: ParsedStoragePath[] = [];
  const mappingPaths: ParsedStoragePath[] = [];
  for (const item of layout.storage) {
    collectReversiblePaths(
      layout,
      findStorageType(layout, item.type),
      { root: item.label, segments: [] },
      paths,
      mappingPaths,
    );
  }

  return {
    slots: paths.flatMap((path) => resolveStoragePath(layout, path)),
    mappingPaths,
  };
}

function collectReversiblePaths(
  layout: StorageLayout,
  type: StorageType,
  path: ParsedStoragePath,
  paths: ParsedStoragePath[],
  mappingPaths: ParsedStoragePath[],
): void {
  if (type.encoding === "mapping") {
    mappingPaths.push(path);
    return;
  }
  if (type.members !== undefined) {
    for (const member of type.members) {
      collectReversiblePaths(
        layout,
        findStorageType(layout, member.type),
        {
          root: path.root,
          segments: [...path.segments, { kind: "field", name: member.label }],
        },
        paths,
        mappingPaths,
      );
    }
    return;
  }
  if (type.encoding === "inplace" && type.base !== undefined) {
    const baseType = findStorageType(layout, type.base);
    for (let index = 0; index < fixedArrayLength(type); index++) {
      collectReversiblePaths(
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
        mappingPaths,
      );
    }
    return;
  }
  paths.push(path);
}

/**
 * Encode a decoded, contract-shaped state object into raw storage slots.
 *
 * The state shape must mirror {@link StorageLayoutToPrimitiveType}: structs are
 * objects, fixed/dynamic arrays are arrays, and mappings are records whose keys
 * are the concrete known mapping keys. Mapping keys do not need to be inferred
 * from slots in this direction; they come from the decoded object itself.
 */
export function encodeStorage<Layout extends StorageLayout>(
  layout: Layout,
  state: StorageLayoutToPrimitiveType<Layout>,
): AccountStorage {
  const storage: AccountStorage = {};
  const root = state as Record<string, unknown>;
  for (const item of layout.storage) {
    encodeStateValue(
      layout,
      findStorageType(layout, item.type),
      { root: item.label, segments: [] },
      root[item.label],
      storage,
    );
  }
  return storage;
}

function encodeStateValue(
  layout: StorageLayout,
  type: StorageType,
  path: ParsedStoragePath,
  value: unknown,
  storage: AccountStorage,
): void {
  if (value === undefined) {
    throw new Error(
      `missing decoded state value for path: ${formatStoragePath(path)}`,
    );
  }

  if (
    type.encoding === "bytes" ||
    (type.encoding === "inplace" &&
      type.members === undefined &&
      type.base === undefined &&
      type.key === undefined)
  ) {
    mergeStorageWrites(layout, path, value, storage);
    return;
  }

  if (type.members !== undefined) {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw new Error(
        `decoded state value must be an object: ${formatStoragePath(path)}`,
      );
    }
    const record = value as Record<string, unknown>;
    for (const member of type.members) {
      encodeStateValue(
        layout,
        findStorageType(layout, member.type),
        {
          root: path.root,
          segments: [...path.segments, { kind: "field", name: member.label }],
        },
        record[member.label],
        storage,
      );
    }
    return;
  }

  if (type.base !== undefined) {
    if (!Array.isArray(value)) {
      throw new Error(
        `decoded state value must be an array: ${formatStoragePath(path)}`,
      );
    }
    if (type.encoding === "dynamic_array") {
      const resolved = resolveStoragePath(layout, path);
      if (
        resolved.length !== 1 ||
        resolved[0]!.type.encoding !== "dynamic_array" ||
        formatStoragePath(resolved[0]!.path) !== formatStoragePath(path)
      ) {
        throw new Error(
          `storage path is not a dynamic array root: ${formatStoragePath(path)}`,
        );
      }
      storage[storageSlot(resolved[0]!)] = Hex.fromNumber(
        BigInt(value.length),
        {
          size: 32,
        },
      );
    } else {
      const length = fixedArrayLength(type);
      if (value.length !== length) {
        throw new Error(
          `fixed array length mismatch at ${formatStoragePath(path)}: expected ${length}, got ${value.length}`,
        );
      }
    }
    const baseType = findStorageType(layout, type.base);
    for (let index = 0; index < value.length; index++) {
      encodeStateValue(
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
        value[index],
        storage,
      );
    }
    return;
  }

  if (type.key !== undefined && type.value !== undefined) {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw new Error(
        `decoded state value must be an object: ${formatStoragePath(path)}`,
      );
    }
    const keyType = findStorageType(layout, type.key);
    const valueType = findStorageType(layout, type.value);
    for (const [key, entry] of Object.entries(value)) {
      const label = keyType.label;
      let subscript: StoragePathSubscript;
      if (label === "address") {
        if (!HEX_STRING_PATTERN.test(key)) {
          throw new Error(
            `mapping key on '${formatStoragePath(path)}' must be a hex string for key type '${label}': '${key}'`,
          );
        }
        subscript = { kind: "hex", value: key as Hex.Hex };
      } else if (label === "bool") {
        if (key !== "true" && key !== "false") {
          throw new Error(
            `mapping key on '${formatStoragePath(path)}' must be 'true' or 'false' for key type '${label}': '${key}'`,
          );
        }
        subscript = { kind: "bool", value: key === "true" };
      } else if (/^u?int[0-9]*$/.test(label)) {
        if (!/^-?(0|[1-9][0-9]*)$/.test(key)) {
          throw new Error(
            `mapping key on '${formatStoragePath(path)}' must be a decimal integer for key type '${label}': '${key}'`,
          );
        }
        subscript = { kind: "number", value: BigInt(key) };
      } else if (/^bytes([1-9]|[12][0-9]|3[0-2])$/.test(label)) {
        if (!HEX_STRING_PATTERN.test(key)) {
          throw new Error(
            `mapping key on '${formatStoragePath(path)}' must be a hex string for key type '${label}': '${key}'`,
          );
        }
        subscript = { kind: "hex", value: key as Hex.Hex };
      } else {
        throw new Error(
          `unsupported mapping key type '${label}' on '${formatStoragePath(path)}'`,
        );
      }
      encodeStateValue(
        layout,
        valueType,
        {
          root: path.root,
          segments: [...path.segments, { kind: "subscript", value: subscript }],
        },
        entry,
        storage,
      );
    }
    return;
  }

  throw new Error(
    `unsupported storage type '${type.label}' at ${formatStoragePath(path)}`,
  );
}

function mergeStorageWrites(
  layout: StorageLayout,
  path: ParsedStoragePath,
  value: unknown,
  storage: AccountStorage,
): void {
  const normalizedPath = normalizeConcreteParsedPath(layout, path);
  const writes = encodeStoragePathRuntime(
    layout,
    formatStoragePath(normalizedPath),
    value,
  );
  for (const [slot, write] of Object.entries(writes)) {
    storage[slot as Hex.Hex] = applySlotWrite(
      write,
      getSlotValue(storage, slot as Hex.Hex) ??
        Hex.fromNumber(0n, { size: 32 }),
    );
  }
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

function uniqueSlots(slots: readonly ResolvedStorageItem[]): Hex.Hex[] {
  const unique: Hex.Hex[] = [];
  const seen = new Set<string>();
  for (const resolved of slots) {
    const slot = storageSlot(resolved);
    const key = slot.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    unique.push(slot);
  }
  return unique;
}

function resolvedPathEndsAtValue(
  resolved: readonly ResolvedStorageItem[],
  path: ParsedStoragePath,
): boolean {
  return (
    resolved.length === 1 &&
    resolved[0]!.type.encoding !== "dynamic_array" &&
    formatStoragePath(resolved[0]!.path) === formatStoragePath(path)
  );
}

function mappingPathError(path: ParsedStoragePath): string {
  return `cannot infer storage path for mapping '${formatStoragePath(path)}' from raw slots: Solidity mapping keys are hashed into storage slots and cannot be reversed from a slot alone`;
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

function getSlotValue(
  storage: AccountStorage,
  requestedSlot: Hex.Hex,
): Hex.Hex | undefined {
  const normalized = normalizeSlot(requestedSlot);
  const direct = storage[normalized];
  if (direct !== undefined) {
    return normalizeSlotValue(direct);
  }

  for (const [slot, value] of Object.entries(storage)) {
    if (
      normalizeSlot(slot as Hex.Hex).toLowerCase() === normalized.toLowerCase()
    ) {
      return normalizeSlotValue(value as Hex.Hex);
    }
  }
  return undefined;
}
