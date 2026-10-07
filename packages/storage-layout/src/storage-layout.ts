import { Hash, Hex } from "ox";
import {
  arrayElementLocation,
  encodeMappingKey,
  fixedArrayLength,
  keccakSlot,
  toWord,
} from "./solidity-encoding";
import {
  formatSubscript,
  readIdentifier,
  readSubscript,
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

/** Where the value that a selector selects is stored. */
export type StorageLocation = {
  /** Solidity type of the value. */
  type: StorageType;
  /** Absolute slot where the value resides or, for multi-slot values, starts. */
  slot: bigint;
  /** Byte offset of the value within `slot`, from the least-significant byte. */
  offset: number;
  /** Canonical selector of the value, for example `balances[0x…]`. */
  selector: string;
};

/**
 * Resolve a selector to the location of the value it selects. A composite
 * (struct, array, or mapping) resolves to the location where it starts.
 */
export function resolveStoragePath(
  layout: StorageLayout,
  selector: string,
): StorageLocation {
  const root = readIdentifier(selector, 0);
  let location = resolveRoot(layout, root.value);
  let index = root.next;
  while (index < selector.length) {
    const char = selector[index];
    if (char === ".") {
      const field = readIdentifier(selector, index + 1);
      location = resolveField(layout, location, field.value);
      index = field.next;
    } else if (char === "[") {
      const subscript = readSubscript(selector, index);
      location = resolveSubscript(layout, location, subscript.value);
      index = subscript.next;
    } else {
      throw new Error(`unexpected '${char}' in storage path: ${selector}`);
    }
  }
  return location;
}

/** Location of the top-level state variable `label`. */
export function resolveRoot(
  layout: StorageLayout,
  label: string,
): StorageLocation {
  const item = layout.storage.find((candidate) => candidate.label === label);
  if (item === undefined) {
    throw new Error(`storage variable not found: ${label}`);
  }
  return {
    type: findStorageType(layout, item.type),
    slot: BigInt(item.slot),
    offset: item.offset,
    selector: label,
  };
}

/** Location of struct field `name` in the struct at `parent`. */
export function resolveField(
  layout: StorageLayout,
  parent: StorageLocation,
  name: string,
): StorageLocation {
  if (isStructType(parent.type) === false) {
    throw new Error(
      `storage path field '${name}' requires a struct: ${parent.selector}`,
    );
  }
  const member = parent.type.members.find(
    (candidate) => candidate.label === name,
  );
  if (member === undefined) {
    throw new Error(`struct field not found: ${parent.selector}.${name}`);
  }
  return {
    type: findStorageType(layout, member.type),
    slot: parent.slot + BigInt(member.slot),
    offset: member.offset,
    selector: `${parent.selector}.${name}`,
  };
}

/**
 * Location of the array element or mapping value at `subscript` in `parent`.
 * A mapping value or a dynamic array element costs one keccak256.
 */
export function resolveSubscript(
  layout: StorageLayout,
  parent: StorageLocation,
  subscript: StoragePathSubscript,
): StorageLocation {
  const { type } = parent;
  const selector = `${parent.selector}[${formatSubscript(subscript)}]`;

  if (isFixedArrayType(type) || isDynamicArrayType(type)) {
    const kind = type.encoding === "dynamic_array" ? "dynamic" : "fixed";
    const index = subscriptToInteger(subscript);
    if (index === undefined) {
      throw new Error(`${kind} array index must be a number: ${selector}`);
    }
    if (
      index < 0n ||
      (kind === "fixed" && index >= BigInt(fixedArrayLength(type)))
    ) {
      throw new Error(`${kind} array index out of bounds: ${selector}`);
    }
    const elementType = findStorageType(layout, type.base);
    const element = arrayElementLocation(elementType, index);
    const dataSlot = kind === "fixed" ? parent.slot : keccakSlot(parent.slot);
    return {
      type: elementType,
      slot: dataSlot + element.slot,
      offset: element.offset,
      selector,
    };
  }

  if (isMappingType(type)) {
    const key = encodeMappingKey(
      findStorageType(layout, type.key),
      subscript,
      parent.selector,
    );
    return {
      type: findStorageType(layout, type.value),
      slot: BigInt(Hash.keccak256(Hex.concat(key, toWord(parent.slot)))),
      offset: 0,
      selector,
    };
  }

  throw new Error(
    `storage path subscript requires an array or mapping: ${selector}`,
  );
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
