import {
  type AsyncStorageGetter,
  fetchStorage,
  type StorageGetter,
} from "./account-storage";
import { bytesDataSlots, decodeStorageLocation } from "./decodeStorageVariable";
import { hasMappingKey, mappingKeys } from "./enumerateMappingKeys";
import { decodeDynamicArrayLength } from "./getDynamicArrayLength";
import { fixedArrayLength } from "./solidity-encoding";
import {
  findStorageType,
  isDynamicArrayType,
  isFixedArrayType,
  isMappingType,
  isStructType,
  resolveField,
  resolveRoot,
  resolveSubscript,
  type StorageLayout,
  type StorageLocation,
} from "./storage-layout";
import { formatSubscript, parseSubscript } from "./storage-path";
import type {
  AccountStorage,
  KeccakPreimage,
  StorageLayoutToPrimitiveType,
} from "./types";

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
  // biome-ignore lint/suspicious/noExplicitAny: a loose layout has no inferred shape.
  readonly [key: string]: any;
  // biome-ignore lint/suspicious/noExplicitAny: a loose layout has no inferred shape.
  readonly [index: number]: any;
};

/**
 * Type of the view from {@link createStorageView}: a readonly
 * {@link StorageLayoutToPrimitiveType}. With an async getter, leaves and
 * dynamic array `length` are promises.
 */
export type StorageView<
  L extends StorageLayout,
  isAsync extends boolean,
> = string extends L["storage"][number]["label"]
  ? UntypedStorageView
  : StorageViewValue<StorageLayoutToPrimitiveType<L>, isAsync>;

/**
 * Create a lazy, read-only view of contract storage. Property access follows
 * the layout (`state.balances[account]`, `state.numbers.length`). A leaf read
 * calls `getStorage` with the slots it needs, with no cache. A composite gives
 * a nested view.
 *
 * Enumeration lists top-level variables, struct fields, fixed array indexes,
 * and the mapping keys found in `preimages`. A dynamic array cannot be
 * enumerated: read `length` and index it. The names `then`, `catch`,
 * `finally`, `toJSON`, and `asymmetricMatch` give `undefined`, so a state
 * variable with one of those names cannot be read.
 *
 * @param layout - Solidity compiler `storageLayout` output.
 * @param getStorage - One value per slot, in order. A sync getter makes leaf
 * reads return values; an async getter makes them return promises.
 * @param preimages - keccak256 preimages for mapping keys, read again on each
 * enumeration.
 *
 * @example
 * ```ts
 * const state = createStorageView(layout, getStorage, preimages);
 * const balance = await state.balances["0x…"]; // bigint
 * const holders = Object.keys(state.balances);
 * ```
 */
export function createStorageView<
  L extends StorageLayout,
  G extends StorageGetter,
>(
  layout: L,
  getStorage: G,
  preimages: readonly KeccakPreimage[] = [],
): NoInfer<StorageView<L, G extends AsyncStorageGetter ? true : false>> {
  const context = { layout, getStorage, preimages };
  return createNode(context, undefined) as StorageView<
    L,
    G extends AsyncStorageGetter ? true : false
  >;
}

type Context = {
  layout: StorageLayout;
  getStorage: StorageGetter;
  preimages: readonly KeccakPreimage[];
};

/** A composite's location, or `undefined` for the root view. */
type Node = StorageLocation | undefined;

// Runtimes probe these names; `undefined` keeps `await`, `JSON.stringify`, and
// test matchers from treating a view as a thenable, `toJSON`, or a matcher.
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
        if (isFixedArrayType(node.type)) return fixedArrayLength(node.type);
        if (isDynamicArrayType(node.type)) {
          return readLeaf(context, node, (storage) =>
            decodeDynamicArrayLength(node, storage),
          );
        }
      }
      const child = resolveProperty(context.layout, node, property);
      const { type } = child;
      if (
        isStructType(type) ||
        isFixedArrayType(type) ||
        isDynamicArrayType(type) ||
        isMappingType(type)
      ) {
        return createNode(context, child);
      }
      return readLeaf(context, child, (storage) =>
        decodeStorageLocation(child, storage),
      );
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

/** Location of `property` under `node`: a struct field or a subscript. */
function resolveProperty(
  layout: StorageLayout,
  node: Node,
  property: string,
): StorageLocation {
  if (node === undefined) return resolveRoot(layout, property);
  if (isStructType(node.type)) return resolveField(layout, node, property);
  const subscript = parseSubscript(property);
  if (subscript === undefined) {
    throw new Error(
      `'${property}' is not a valid subscript for ${node.selector}`,
    );
  }
  return resolveSubscript(layout, node, subscript);
}

function enumerableKeys(context: Context, node: Node): string[] {
  if (node === undefined) {
    return context.layout.storage.map((item) => item.label);
  }
  const { type } = node;
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
    return mappingKeys(keyType, node.slot, context.preimages).map(
      formatSubscript,
    );
  }
  throw new Error(
    `cannot enumerate dynamic array ${node.selector}: read its length and index it instead`,
  );
}

/**
 * Whether `property` is an enumerable key. `Object.keys` calls this for each
 * listed key, and a mapping key scans `preimages`.
 */
function hasKey(context: Context, node: Node, property: string): boolean {
  if (node === undefined) {
    return context.layout.storage.some((item) => item.label === property);
  }
  const { type } = node;
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
        node.slot,
        key,
        context.preimages,
      )
    );
  }
  return false;
}

/** `console.log` text. It does not read storage. */
function describe(context: Context, node: Node): string {
  const name =
    node === undefined ? "StorageView" : `StorageView ${node.selector}`;
  if (node !== undefined && isDynamicArrayType(node.type)) {
    return `${name} [dynamic array]`;
  }
  const keys = enumerableKeys(context, node);
  return keys.length === 0 ? `${name} {}` : `${name} { ${keys.join(", ")} }`;
}

/**
 * Read the slots at `location` and pass them to `decode`: the value with a
 * sync getter, a promise with an async one. A long `bytes`/`string` value
 * needs a second read for its data slots.
 */
function readLeaf(
  context: Context,
  location: StorageLocation,
  decode: (storage: AccountStorage) => unknown,
): unknown {
  const { getStorage } = context;
  const root = fetchStorage(getStorage, [location.slot]);
  if (root instanceof Promise) {
    return root.then(async (root) => {
      const slots = bytesDataSlots(location, root);
      const data =
        slots.length === 0 ? {} : await fetchStorage(getStorage, slots);
      return decode({ ...root, ...data });
    });
  }
  const slots = bytesDataSlots(location, root);
  // A sync getter gave the root, so it gives the data synchronously too.
  const data =
    slots.length === 0
      ? {}
      : (fetchStorage(getStorage, slots) as AccountStorage);
  return decode({ ...root, ...data });
}
