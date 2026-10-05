import { Hash, Hex } from "ox";
import {
  arrayElementLocation,
  encodeMappingKey,
  fixedArrayLength,
  keccakSlot,
  toWord,
} from "./solidity-encoding";
import {
  formatStoragePath,
  formatSubscript,
  type StoragePath,
  type StoragePathSubscript,
  subscriptToInteger,
} from "./storage-path";

/**
 * Storage item as defined in the JSON output of the Solidity compiler.
 *
 * @see https://docs.soliditylang.org/en/latest/internals/layout_in_storage.html#json-output
 */
export type StorageItem = {
  /** ID of the AST node of the state variable's declaration. */
  astId: number;
  /** Name of the contract including its path as prefix. */
  contract: `${string}:${string}`;
  /** Name of the state variable. */
  label: string;
  /** Offset in bytes within the storage slot according to the encoding. */
  offset: number;
  /** Storage slot where the state variable resides or starts. */
  slot: `${number}`;
  /** Identifier used as key to the variable's type information. */
  type: string;
};

/**
 * Storage type as defined in the JSON output of the Solidity compiler.
 *
 * @see https://docs.soliditylang.org/en/latest/internals/layout_in_storage.html#json-output
 */
export type StorageType = {
  /** How the data is encoded in storage. */
  encoding: "inplace" | "dynamic_array" | "bytes" | "mapping";
  /** Canonical type name. */
  label: string;
  /** Number of used bytes. If greater than 32, the value spans multiple slots. */
  numberOfBytes: `${number}`;
  /** Members for struct types. */
  members?: readonly StorageItem[];
  /** Base type for array types. */
  base?: string;
  /** Key type for mapping types. */
  key?: string;
  /** Value type for mapping types. */
  value?: string;
};

/**
 * Storage layout as defined in the JSON output of the Solidity compiler.
 *
 * @see https://docs.soliditylang.org/en/latest/internals/layout_in_storage.html#json-output
 */
export type StorageLayout = {
  storage: readonly StorageItem[];
  types: Record<string, StorageType>;
};

/** Absolute position of the value that a storage path selects. */
export type StorageLocation = {
  /** Solidity type of the value. */
  type: StorageType;
  /** Absolute slot where the value resides or, for multi-slot values, starts. */
  slot: bigint;
  /** Byte offset of the value within `slot`, from the least-significant byte. */
  offset: number;
};

/**
 * Resolve a storage path to the absolute location of the value it selects.
 *
 * Each segment moves one level into the current type: a struct field adds the
 * member's slot, an array subscript adds the element's slot (relative to
 * `keccak256(slot)` for dynamic arrays), and a mapping subscript hashes the key
 * with the mapping's slot. A composite path (struct, array, or mapping)
 * resolves to the location where that composite starts.
 */
export function resolveStoragePath(
  layout: StorageLayout,
  path: StoragePath,
): StorageLocation {
  const item = findStorageItem(layout, path.root);
  let location: StorageLocation = {
    type: findStorageType(layout, item.type),
    slot: BigInt(item.slot),
    offset: item.offset,
  };

  for (const [index, segment] of path.segments.entries()) {
    const parent: StoragePath = {
      root: path.root,
      segments: path.segments.slice(0, index),
    };
    location =
      segment.kind === "field"
        ? resolveField(layout, location, segment.name, parent)
        : resolveSubscript(layout, location, segment.value, parent);
  }

  return location;
}

export function findStorageItem(
  layout: StorageLayout,
  label: string,
): StorageItem {
  const item = layout.storage.find((candidate) => candidate.label === label);
  if (item === undefined) {
    throw new Error(`storage variable not found: ${label}`);
  }
  return item;
}

export function findStorageType(
  layout: StorageLayout,
  typeId: string,
): StorageType {
  const type = layout.types[typeId];
  if (type === undefined) {
    throw new Error(`storage type not found: ${typeId}`);
  }
  return type;
}

export function isStructType(
  type: StorageType,
): type is StorageType & { members: readonly StorageItem[] } {
  return type.encoding === "inplace" && type.members !== undefined;
}

export function isFixedArrayType(
  type: StorageType,
): type is StorageType & { base: string } {
  return type.encoding === "inplace" && type.base !== undefined;
}

export function isDynamicArrayType(
  type: StorageType,
): type is StorageType & { base: string } {
  return type.encoding === "dynamic_array" && type.base !== undefined;
}

export function isMappingType(
  type: StorageType,
): type is StorageType & { key: string; value: string } {
  return (
    type.encoding === "mapping" &&
    type.key !== undefined &&
    type.value !== undefined
  );
}

function resolveField(
  layout: StorageLayout,
  location: StorageLocation,
  name: string,
  parent: StoragePath,
): StorageLocation {
  if (isStructType(location.type) === false) {
    throw new Error(
      `storage path field '${name}' requires a struct: ${formatStoragePath(parent)}`,
    );
  }
  const member = location.type.members.find(
    (candidate) => candidate.label === name,
  );
  if (member === undefined) {
    throw new Error(
      `struct field not found: ${formatStoragePath(parent)}.${name}`,
    );
  }
  return {
    type: findStorageType(layout, member.type),
    slot: location.slot + BigInt(member.slot),
    offset: member.offset,
  };
}

function resolveSubscript(
  layout: StorageLayout,
  location: StorageLocation,
  subscript: StoragePathSubscript,
  parent: StoragePath,
): StorageLocation {
  const { type } = location;
  const path = () =>
    `${formatStoragePath(parent)}[${formatSubscript(subscript)}]`;

  if (isFixedArrayType(type)) {
    const index = subscriptToInteger(subscript);
    if (index === undefined) {
      throw new Error(`fixed array index must be a number: ${path()}`);
    }
    if (index < 0n || index >= BigInt(fixedArrayLength(type))) {
      throw new Error(`fixed array index out of bounds: ${path()}`);
    }
    return arrayElement(layout, type.base, location.slot, index);
  }

  if (isDynamicArrayType(type)) {
    const index = subscriptToInteger(subscript);
    if (index === undefined) {
      throw new Error(`dynamic array index must be a number: ${path()}`);
    }
    if (index < 0n) {
      throw new Error(`dynamic array index out of bounds: ${path()}`);
    }
    return arrayElement(layout, type.base, keccakSlot(location.slot), index);
  }

  if (isMappingType(type)) {
    const key = encodeMappingKey(
      findStorageType(layout, type.key),
      subscript,
      formatStoragePath(parent),
    );
    return {
      type: findStorageType(layout, type.value),
      slot: BigInt(Hash.keccak256(Hex.concat(key, toWord(location.slot)))),
      offset: 0,
    };
  }

  throw new Error(
    `storage path subscript requires an array or mapping: ${path()}`,
  );
}

function arrayElement(
  layout: StorageLayout,
  baseTypeId: string,
  dataSlot: bigint,
  index: bigint,
): StorageLocation {
  const type = findStorageType(layout, baseTypeId);
  const element = arrayElementLocation(type, index);
  return { type, slot: dataSlot + element.slot, offset: element.offset };
}
