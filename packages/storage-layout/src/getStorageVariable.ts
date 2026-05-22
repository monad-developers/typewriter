import { Hex } from "ox";
import {
  findStorageType,
  fixedArrayLength,
  type ResolvedStorageItem,
  resolveStoragePath,
  type StorageLayout,
  type StorageType,
} from "./storage-layout";
import {
  formatStoragePath,
  normalizePath,
  type StoragePath as ParsedStoragePath,
} from "./storage-path";
import type { StorageVariable } from "./types";

/**
 * Matches a raw slot back to storage variable selector strings.
 *
 * The result is an array because packed fields may return multiple variables.
 *
 * Mapping slots are not reversible from a slot alone because Solidity hashes
 * mapping keys into slot addresses. Pass `knownVariables` to match keyed
 * mapping variables or other concrete variables the application already knows.
 *
 * @param storageLayout - Solidity compiler `storageLayout` output.
 * @param slot - Raw storage slot.
 * @param knownVariables - Optional storage variables used to match keyed mappings.
 */
export function getStorageVariable<const layout extends StorageLayout>(
  storageLayout: layout,
  slot: Hex.Hex,
  knownVariables?: readonly StorageVariable<NoInfer<layout>>[],
): StorageVariable<layout>[] {
  const { slots: layoutSlots, mappingPaths } =
    collectLayoutSlots(storageLayout);
  const knownSlots = knownVariables?.flatMap((knownVariable) =>
    resolveStoragePath(storageLayout, normalizePath(knownVariable as string)),
  );
  const matches: StorageVariable<layout>[] = [];
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
  if (!matchedLayout && !matchedKnown && knownVariables === undefined) {
    const [mappingPath] = mappingPaths;
    if (mappingPath !== undefined) {
      throw new Error(mappingPathError(mappingPath));
    }
  }

  return matches;
}

function addSlotMatches<layout extends StorageLayout>(
  matches: StorageVariable<layout>[],
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
    matches.push(key as StorageVariable<layout>);
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

function mappingPathError(path: ParsedStoragePath): string {
  return `cannot infer storage variable for mapping '${formatStoragePath(path)}' from raw slot: Solidity hashes mapping keys into slot addresses, so mapping slots are not reversible from a slot alone; pass knownVariables to match keyed mappings`;
}

function normalizeSlot(slot: Hex.Hex): Hex.Hex {
  return Hex.fromNumber(BigInt(slot), { size: 32 });
}

function storageSlot(resolved: ResolvedStorageItem): Hex.Hex {
  return Hex.fromNumber(resolved.baseSlot + BigInt(resolved.item.slot), {
    size: 32,
  });
}
