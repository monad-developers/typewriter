import { Hash, Hex } from "ox";
import { getStorageSlot } from "./getStorageSlot";
import { getStorageVariable } from "./getStorageVariable";
import {
  arrayElementLocation,
  fixedArrayLength,
  integerBits,
  isValueType,
  normalizeSlot,
} from "./solidity-encoding";
import {
  findStorageType,
  resolveStoragePath,
  type StorageLayout,
  type StorageType,
} from "./storage-layout";
import {
  formatStoragePath,
  normalizePath,
  type StoragePath,
  type StoragePathSubscript,
} from "./storage-path";
import type { ConcreteStorageVariable } from "./types";

export type KeccakPreimage = {
  hash: Hex.Hex;
  preimage: Hex.Hex;
};

type Preimage = {
  hashSlot: bigint;
  preimage: Hex.Hex;
};

export function recoverStoragePaths<const layout extends StorageLayout>(
  layout: layout,
  touchedSlots: readonly Hex.Hex[],
  preimages: readonly KeccakPreimage[],
): readonly ConcreteStorageVariable<layout>[] {
  const normalizedPreimages = normalizePreimages(preimages);
  const seen = new Set<string>();
  const paths: string[] = [];

  for (const touchedSlot of touchedSlots) {
    const slot = normalizeSlot(touchedSlot);
    const candidates = recoverTouchedSlot(layout, slot, normalizedPreimages);
    if (candidates.length === 0) {
      // A slot with no candidates is only a recovery gap worth surfacing when
      // it was produced by a captured keccak preimage (a mapping/array/bytes
      // structure we should have been able to walk). Slots unrelated to any
      // captured preimage — e.g. dynamic (string/bytes) mapping keys, whose
      // variable-length preimages the harness never records — are skipped so a
      // single unsupported key doesn't abort recovery of the other slots.
      if (slotDerivesFromPreimage(BigInt(slot), normalizedPreimages)) {
        throw new Error(
          `could not recover storage path for touched slot ${slot}`,
        );
      }
      continue;
    }

    for (const candidate of candidates) {
      if (seen.has(candidate)) {
        continue;
      }
      seen.add(candidate);
      paths.push(candidate);
    }
  }

  return paths as unknown as readonly ConcreteStorageVariable<layout>[];
}

function recoverTouchedSlot(
  layout: StorageLayout,
  slot: Hex.Hex,
  preimages: readonly Preimage[],
): string[] {
  const target = BigInt(slot);
  const candidates = new Set<string>(getStorageVariable(layout, slot, []));

  for (const item of layout.storage) {
    collectRecoveredPaths(
      layout,
      findStorageType(layout, item.type),
      BigInt(item.slot),
      { root: item.label, segments: [] },
      target,
      preimages,
      candidates,
    );
  }

  return [...candidates].filter((candidate) =>
    pathIncludesSlot(layout, candidate, slot, preimages),
  );
}

function collectRecoveredPaths(
  layout: StorageLayout,
  type: StorageType,
  baseSlot: bigint,
  path: StoragePath,
  target: bigint,
  preimages: readonly Preimage[],
  out: Set<string>,
): void {
  if (type.encoding === "mapping") {
    collectMappingPaths(layout, type, baseSlot, path, target, preimages, out);
    return;
  }

  if (type.encoding === "dynamic_array") {
    if (target === baseSlot) {
      out.add(formatStoragePath(path));
    }
    collectDynamicArrayPaths(
      layout,
      type,
      baseSlot,
      path,
      target,
      preimages,
      out,
    );
    return;
  }

  if (type.encoding === "bytes") {
    if (target === baseSlot || isDynamicDataSlot(baseSlot, target, preimages)) {
      out.add(formatStoragePath(path));
    }
    return;
  }

  if (type.members !== undefined) {
    for (const member of type.members) {
      collectRecoveredPaths(
        layout,
        findStorageType(layout, member.type),
        baseSlot + BigInt(member.slot),
        {
          root: path.root,
          segments: [...path.segments, { kind: "field", name: member.label }],
        },
        target,
        preimages,
        out,
      );
    }
    return;
  }

  if (type.encoding === "inplace" && type.base !== undefined) {
    const baseType = findStorageType(layout, type.base);
    for (let index = 0; index < fixedArrayLength(type); index++) {
      const elementSlot = arrayElementLocation(baseType, BigInt(index)).slot;
      collectRecoveredPaths(
        layout,
        baseType,
        baseSlot + elementSlot,
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
        target,
        preimages,
        out,
      );
    }
    return;
  }

  if (target === baseSlot) {
    out.add(formatStoragePath(path));
  }
}

function collectMappingPaths(
  layout: StorageLayout,
  type: StorageType,
  baseSlot: bigint,
  path: StoragePath,
  target: bigint,
  preimages: readonly Preimage[],
  out: Set<string>,
): void {
  if (type.key === undefined || type.value === undefined) {
    return;
  }
  const keyType = findStorageType(layout, type.key);
  const valueType = findStorageType(layout, type.value);

  for (const entry of preimages) {
    if (Hex.size(entry.preimage) !== 64) {
      continue;
    }
    const parentSlot = BigInt(Hex.slice(entry.preimage, 32, 64));
    if (parentSlot !== baseSlot) {
      continue;
    }
    const key = decodeMappingKey(keyType, Hex.slice(entry.preimage, 0, 32));
    if (key === undefined) {
      continue;
    }
    collectRecoveredPaths(
      layout,
      valueType,
      entry.hashSlot,
      {
        root: path.root,
        segments: [...path.segments, { kind: "subscript", value: key }],
      },
      target,
      preimages,
      out,
    );
  }
}

function collectDynamicArrayPaths(
  layout: StorageLayout,
  type: StorageType,
  baseSlot: bigint,
  path: StoragePath,
  target: bigint,
  preimages: readonly Preimage[],
  out: Set<string>,
): void {
  if (type.base === undefined) {
    return;
  }
  const baseType = findStorageType(layout, type.base);
  for (const entry of preimages) {
    if (
      Hex.size(entry.preimage) !== 32 ||
      BigInt(entry.preimage) !== baseSlot
    ) {
      continue;
    }
    for (const delta of dynamicArrayCandidateDeltas(
      entry.hashSlot,
      target,
      preimages,
    )) {
      for (const index of dynamicArrayCandidateIndexes(baseType, delta)) {
        collectRecoveredPaths(
          layout,
          baseType,
          entry.hashSlot + arrayElementLocation(baseType, index).slot,
          {
            root: path.root,
            segments: [
              ...path.segments,
              { kind: "subscript", value: { kind: "number", value: index } },
            ],
          },
          target,
          preimages,
          out,
        );
      }
    }
  }
}

function dynamicArrayCandidateDeltas(
  dataBaseSlot: bigint,
  target: bigint,
  preimages: readonly Preimage[],
): bigint[] {
  const deltas = new Set<bigint>();
  if (target >= dataBaseSlot) {
    deltas.add(target - dataBaseSlot);
  }
  for (const entry of preimages) {
    const parentSlot = keccakParentSlot(entry);
    if (
      parentSlot !== undefined &&
      parentSlot >= dataBaseSlot &&
      slotDerivesFromHash(entry.hashSlot, target)
    ) {
      deltas.add(parentSlot - dataBaseSlot);
    }
  }
  return [...deltas];
}

// Upper bound on how far past a keccak output a slot can sit while still being
// treated as derived from it (struct field offsets, packed array elements,
// dynamic-bytes chunks). Hashed slots are uniformly spread across 2^256, so a
// span this small never collides two unrelated structures in practice.
const SLOT_HASH_CHAIN_SPAN = 4096n;

/**
 * Whether `target` was produced by one of the captured keccak preimages, either
 * as the hash output itself or as a bounded offset from it. A failed recovery
 * for such a slot is a real gap; a slot unrelated to any preimage is not.
 */
function slotDerivesFromPreimage(
  target: bigint,
  preimages: readonly Preimage[],
): boolean {
  return preimages.some((entry) => slotDerivesFromHash(entry.hashSlot, target));
}

function slotDerivesFromHash(hashSlot: bigint, target: bigint): boolean {
  return (
    hashSlot === target ||
    (target > hashSlot && target - hashSlot < SLOT_HASH_CHAIN_SPAN)
  );
}

function keccakParentSlot(entry: Preimage): bigint | undefined {
  const size = Hex.size(entry.preimage);
  if (size === 32) {
    return BigInt(entry.preimage);
  }
  if (size === 64) {
    return BigInt(Hex.slice(entry.preimage, 32, 64));
  }
  return undefined;
}

function dynamicArrayCandidateIndexes(
  type: StorageType,
  delta: bigint,
): bigint[] {
  const bytes = Number(type.numberOfBytes);
  if (isValueType(type) && bytes < 32) {
    const valuesPerSlot = BigInt(Math.floor(32 / bytes));
    const first = delta * valuesPerSlot;
    return Array.from(
      { length: Number(valuesPerSlot) },
      (_, index) => first + BigInt(index),
    );
  }
  const span = slotSpan(type);
  return [delta / span];
}

function decodeMappingKey(
  type: StorageType,
  encoded: Hex.Hex,
): StoragePathSubscript | undefined {
  const label = type.label;
  const word = normalizeSlot(encoded);
  if (label === "address") {
    return { kind: "hex", value: Hex.slice(word, 12, 32) };
  }
  if (label === "bool") {
    const value = BigInt(word);
    if (value !== 0n && value !== 1n) {
      return undefined;
    }
    return { kind: "bool", value: value === 1n };
  }
  if (label.startsWith("uint")) {
    const value = BigInt(word);
    const bits = integerBits(label, "uint");
    if (value >= 1n << BigInt(bits)) {
      return undefined;
    }
    return { kind: "number", value };
  }
  if (label.startsWith("int")) {
    const bits = integerBits(label, "int");
    const raw = BigInt(word);
    const value = raw >= 1n << 255n ? raw - (1n << 256n) : raw;
    const min = -(1n << BigInt(bits - 1));
    const max = (1n << BigInt(bits - 1)) - 1n;
    if (value < min || value > max) {
      return undefined;
    }
    return { kind: "number", value };
  }
  if (/^bytes([1-9]|[12][0-9]|3[0-2])$/.test(label)) {
    return {
      kind: "hex",
      value: Hex.slice(word, 0, Number(label.slice("bytes".length))),
    };
  }
  return undefined;
}

function normalizePreimages(
  preimages: readonly KeccakPreimage[],
): readonly Preimage[] {
  return preimages
    .filter((entry) => {
      const size = Hex.size(entry.preimage);
      return size === 32 || size === 64;
    })
    .map((entry) => {
      const preimage = Hex.from(entry.preimage);
      const hash = normalizeSlot(entry.hash);
      const computedHash = normalizeSlot(Hash.keccak256(preimage));
      if (hash !== computedHash) {
        throw new Error(
          `keccak preimage hash mismatch: ${hash} != ${computedHash}`,
        );
      }
      return { hashSlot: BigInt(hash), preimage };
    });
}
function pathIncludesSlot(
  layout: StorageLayout,
  path: string,
  slot: Hex.Hex,
  preimages: readonly Preimage[],
): boolean {
  try {
    if (
      getStorageSlot(layout, path).some(
        (candidate) => normalizeSlot(candidate) === slot,
      )
    ) {
      return true;
    }

    const target = BigInt(slot);
    return resolveStoragePath(layout, normalizePath(path)).some((resolved) => {
      if (resolved.type.encoding !== "bytes") {
        return false;
      }
      return isDynamicDataSlot(
        resolved.baseSlot + BigInt(resolved.item.slot),
        target,
        preimages,
      );
    });
  } catch {
    return false;
  }
}

function isDynamicDataSlot(
  baseSlot: bigint,
  target: bigint,
  preimages: readonly Preimage[],
): boolean {
  return preimages.some(
    (entry) =>
      Hex.size(entry.preimage) === 32 &&
      BigInt(entry.preimage) === baseSlot &&
      target >= entry.hashSlot,
  );
}

function slotSpan(type: StorageType): bigint {
  return BigInt(Math.max(1, Math.ceil(Number(type.numberOfBytes) / 32)));
}
