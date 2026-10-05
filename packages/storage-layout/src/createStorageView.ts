// A lazy, read-only object view of contract storage. Each property access
// moves one level into the layout: a composite (struct, array, or mapping)
// returns a nested view, and a leaf (value type, `bytes`, or `string`) reads
// its slots through `getStorage` and decodes them. There is no cache: every
// leaf read calls `getStorage`.
//
// The return type of `getStorage` decides sync or async behavior. A sync getter
// makes leaf reads return values. An async getter makes them return promises.
// Composite access always returns a nested view synchronously.

import type { Hex } from "ox";
import { createSlotReader } from "./account-storage";
import { bytesDataSlots, decodeStorageVariable } from "./decodeStorageVariable";
import { hasMappingKey, mappingKeys } from "./enumerateMappingKeys";
import { getDynamicArrayLength } from "./getDynamicArrayLength";
import { fixedArrayLength, toWord } from "./solidity-encoding";
import {
  findStorageItem,
  findStorageType,
  isDynamicArrayType,
  isFixedArrayType,
  isMappingType,
  isStructType,
  resolveStoragePath,
  type StorageLayout,
  type StorageLocation,
} from "./storage-layout";
import {
  formatStoragePath,
  formatSubscript,
  parseSubscript,
  type StoragePath,
} from "./storage-path";
import type {
  AccountStorage,
  KeccakPreimage,
  StorageLayoutToPrimitiveType,
} from "./types";

// -----------------------------------------------------------------------------
// Public types

/**
 * Reads raw slot values. It returns one 32-byte value per slot, in the same
 * order as `slots`, like a DataLoader batch function or `eth_getProof`.
 */
type SyncStorageGetter = (slots: readonly Hex.Hex[]) => readonly Hex.Hex[];
/** Asynchronous {@link SyncStorageGetter}. */
type AsyncStorageGetter = (
  slots: readonly Hex.Hex[],
) => Promise<readonly Hex.Hex[]>;
type StorageGetter = SyncStorageGetter | AsyncStorageGetter;

type StorageViewValue<T, isAsync extends boolean> = [T] extends [
  readonly unknown[],
]
  ? number extends T["length"]
    ? T extends readonly (infer Element)[]
      ? DynamicArrayView<Element, isAsync>
      : never
    : { readonly [K in keyof T]: StorageViewValue<T[K], isAsync> }
  : [T] extends [object]
    ? { readonly [K in keyof T]: StorageViewValue<T[K], isAsync> }
    : isAsync extends true
      ? Promise<T>
      : T;

type DynamicArrayView<Element, isAsync extends boolean> = {
  readonly [index: number]: StorageViewValue<Element, isAsync>;
  readonly length: isAsync extends true ? Promise<number> : number;
};

type UntypedStorageView = {
  // biome-ignore lint/suspicious/noExplicitAny: broad layouts are an intentional escape hatch until generated types exist.
  readonly [key: string]: any;
  // biome-ignore lint/suspicious/noExplicitAny: broad layouts are an intentional escape hatch until generated types exist.
  readonly [index: number]: any;
};

/**
 * Inferred shape of the view returned by {@link createStorageView}. The
 * structural shape mirrors {@link StorageLayoutToPrimitiveType}; when the
 * getter is asynchronous, leaf positions are wrapped in `Promise<>`. Dynamic
 * array `.length` is also a storage read, so async-backed views expose it as
 * `Promise<number>`. The whole projection is recursively readonly because view
 * writes are rejected.
 */
export type StorageView<
  L extends StorageLayout,
  isAsync extends boolean,
> = string extends L["storage"][number]["label"]
  ? UntypedStorageView
  : StorageViewValue<StorageLayoutToPrimitiveType<L>, isAsync>;

// -----------------------------------------------------------------------------
// Public API

/**
 * Create a lazy, read-only object view of contract storage, built on a
 * JavaScript `Proxy`.
 *
 * Property access follows the Solidity layout: `state.metadata.lastUpdate`,
 * `state.balances[account]`, `state.numbers[3]`, `state.numbers.length`. Leaf
 * reads call `getStorage` with only the slots that the value needs and decode
 * the result. Composite reads return nested views.
 *
 * Enumeration (`Object.keys`, `for...in`, spread) lists top-level variables,
 * struct fields, fixed array indexes, and the mapping keys found in
 * `preimages` (see {@link enumerateMappingKeys}); `in` agrees with that list.
 * A dynamic array cannot be enumerated, because its length is in storage and
 * enumeration is synchronous: read `length` and index it instead. `console.log` shows a view's selector and keys without
 * reading storage.
 *
 * The property names `then`, `catch`, `finally`, `toJSON`, and
 * `asymmetricMatch` return `undefined`, so `await`, `JSON.stringify`, and test
 * matchers treat views as plain objects. A state variable with one of those
 * names cannot be read through the view.
 *
 * @param layout - Solidity compiler `storageLayout` output.
 * @param getStorage - Reads raw slot values: one value per slot, in the same
 * order as `slots`. Its return type (array or promise)
 * makes leaf reads sync or async.
 * @param preimages - keccak256 preimages that give the known mapping keys.
 * The view reads this array on every enumeration, so later changes are seen.
 *
 * @example
 * ```ts
 * const state = createStorageView(layout, (slots) =>
 *   Promise.all(
 *     slots.map(async (slot) => (await client.getStorageAt({ address, slot })) ?? "0x0"),
 *   ),
 * );
 * const balance = await state.balances["0x…"]; // bigint
 * const holders = Object.keys(state.balances); // keys from preimages
 * ```
 */
export function createStorageView<
  L extends StorageLayout,
  G extends StorageGetter,
>(
  layout: L,
  getStorage: G,
  preimages: readonly KeccakPreimage[] = [],
): StorageView<L, G extends AsyncStorageGetter ? true : false> {
  const context = { layout, getStorage, preimages };
  return createNode(context, undefined) as StorageView<
    L,
    G extends AsyncStorageGetter ? true : false
  >;
}

// -----------------------------------------------------------------------------
// Internals

type Context = {
  layout: StorageLayout;
  getStorage: StorageGetter;
  preimages: readonly KeccakPreimage[];
};

/** A composite node: its path and resolved location. */
type Node = { path: StoragePath; location: StorageLocation } | undefined;

// JS-protocol property names that the runtime probes by name. Returning
// `undefined` keeps `await` (not a thenable), `JSON.stringify` (no `toJSON`),
// and Bun/Jest matchers from treating a proxy as something else.
const RESERVED_PROPERTIES = new Set([
  "then",
  "catch",
  "finally",
  "toJSON",
  "asymmetricMatch",
]);

// Bun and Node inspect a proxy's target directly, without calling traps, so
// `console.log` support goes on the target.
const INSPECT = Symbol.for("nodejs.util.inspect.custom");

/** A view of the composite at `node`, or of the whole layout. */
function createNode(context: Context, node: Node): object {
  const target = Object.create(null);
  Object.defineProperty(target, INSPECT, {
    configurable: true,
    value: () => describe(context, node),
  });

  const readOnly = (_: object, property: string | symbol): never => {
    throw new Error(
      `storage view is read-only (attempted to change ${String(property)})`,
    );
  };
  const isKey = (property: string | symbol) =>
    typeof property === "string" && hasKey(context, node, property);

  return new Proxy(target, {
    get(_, property) {
      if (typeof property === "symbol" || RESERVED_PROPERTIES.has(property)) {
        return undefined;
      }
      if (property === "length" && node !== undefined) {
        const { type } = node.location;
        if (isFixedArrayType(type)) return fixedArrayLength(type);
        if (isDynamicArrayType(type)) return readLength(context, node);
      }
      return read(context, childPath(context.layout, node, property));
    },
    has: (_, property) => isKey(property),
    ownKeys: () => enumerableKeys(context, node),
    getOwnPropertyDescriptor: (_, property) =>
      isKey(property) ? { configurable: true, enumerable: true } : undefined,
    set: readOnly,
    deleteProperty: readOnly,
    defineProperty: readOnly,
  });
}

/** Read a leaf value, or return a nested view of a composite. */
function read(context: Context, path: StoragePath): unknown {
  const location = resolveStoragePath(context.layout, path);
  const { type } = location;
  if (
    isStructType(type) ||
    isFixedArrayType(type) ||
    isDynamicArrayType(type) ||
    isMappingType(type)
  ) {
    return createNode(context, { path, location });
  }
  return readLeaf(context, path, location);
}

/** The path of `property` under `node`. */
function childPath(
  layout: StorageLayout,
  node: Node,
  property: string,
): StoragePath {
  if (node === undefined) {
    findStorageItem(layout, property);
    return { root: property, segments: [] };
  }
  const { path, location } = node;
  if (isStructType(location.type)) {
    return {
      root: path.root,
      segments: [...path.segments, { kind: "field", name: property }],
    };
  }
  const subscript = parseSubscript(property);
  if (subscript === undefined) {
    throw new Error(
      `'${property}' is not a valid subscript for ${formatStoragePath(path)}`,
    );
  }
  return {
    root: path.root,
    segments: [...path.segments, { kind: "subscript", value: subscript }],
  };
}

function enumerableKeys(context: Context, node: Node): string[] {
  if (node === undefined) {
    return context.layout.storage.map((item) => item.label);
  }
  const { path, location } = node;
  const { type } = location;
  if (isStructType(type)) {
    return type.members.map((member) => member.label);
  }
  if (isFixedArrayType(type)) {
    return Array.from({ length: fixedArrayLength(type) }, (_, index) =>
      String(index),
    );
  }
  if (isMappingType(type)) {
    const keyType = findStorageType(context.layout, type.key);
    return mappingKeys(keyType, location.slot, context.preimages).map(
      formatSubscript,
    );
  }
  throw new Error(
    `cannot enumerate dynamic array ${formatStoragePath(path)}: read its length and index it instead`,
  );
}

/**
 * Whether `property` is a key of the node, for `in` and
 * `Object.getOwnPropertyDescriptor`. A mapping key must be known from the
 * preimages, which this scans. `Object.keys` asks once per listed key, so
 * enumerating a mapping costs keys × preimages string comparisons.
 */
function hasKey(context: Context, node: Node, property: string): boolean {
  if (node === undefined) {
    return context.layout.storage.some((item) => item.label === property);
  }
  const { type } = node.location;
  if (isStructType(type)) {
    return type.members.some((member) => member.label === property);
  }
  if (isFixedArrayType(type)) {
    return (
      /^(0|[1-9][0-9]*)$/.test(property) &&
      Number(property) < fixedArrayLength(type)
    );
  }
  if (isMappingType(type)) {
    const key = parseSubscript(property);
    return (
      key !== undefined &&
      hasMappingKey(
        findStorageType(context.layout, type.key),
        node.location.slot,
        key,
        context.preimages,
      )
    );
  }
  return false;
}

/** `console.log` text: the selector and its keys, without reading storage. */
function describe(context: Context, node: Node): string {
  const name =
    node === undefined
      ? "StorageView"
      : `StorageView ${formatStoragePath(node.path)}`;
  if (node !== undefined && isDynamicArrayType(node.location.type)) {
    return `${name} [dynamic array]`;
  }
  const keys = enumerableKeys(context, node);
  return keys.length === 0 ? `${name} {}` : `${name} { ${keys.join(", ")} }`;
}

function readLeaf(
  context: Context,
  path: StoragePath,
  location: StorageLocation,
): unknown {
  const { layout } = context;
  const selector = formatStoragePath(path);
  return chain(fetchSlots(context, [location.slot]), (root) => {
    // A long `bytes`/`string` value needs a second read for its data slots.
    const dataSlots =
      location.type.encoding === "bytes"
        ? bytesDataSlots(
            location.slot,
            createSlotReader(root)(location.slot),
            selector,
          )
        : [];
    if (dataSlots.length === 0) {
      return decodeStorageVariable(layout, selector, root);
    }
    return chain(fetchSlots(context, dataSlots), (data) =>
      decodeStorageVariable(layout, selector, { ...root, ...data }),
    );
  });
}

function readLength(
  context: Context,
  node: { path: StoragePath; location: StorageLocation },
): unknown {
  return chain(fetchSlots(context, [node.location.slot]), (storage) =>
    getDynamicArrayLength(
      context.layout,
      formatStoragePath(node.path),
      storage,
    ),
  );
}

/**
 * Read `slots` through the getter, as account storage for the decoders. The
 * getter must return one value per slot, in order.
 */
function fetchSlots(
  context: Context,
  slots: readonly bigint[],
): AccountStorage | Promise<AccountStorage> {
  const words = slots.map(toWord);
  return chain(context.getStorage(words), (values) => {
    if (values.length !== words.length) {
      throw new Error(
        `getStorage returned ${values.length} values for ${words.length} slots`,
      );
    }
    const storage: AccountStorage = {};
    for (const [index, slot] of words.entries()) {
      const value = values[index];
      if (value === undefined) {
        throw new Error(`getStorage returned no value for slot: ${slot}`);
      }
      storage[slot] = value;
    }
    return storage;
  });
}

/**
 * Apply `f` now if `value` is not a promise, or after it resolves. This lets
 * one code path serve both sync and async getters.
 */
function chain<T, R>(
  value: T | Promise<T>,
  f: (resolved: T) => R | Promise<R>,
): R | Promise<R> {
  return value instanceof Promise ? value.then(f) : f(value);
}
