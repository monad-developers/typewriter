// Lazy projection of a Solidity storage layout into a JS-object-shaped reader.
//
// The proxy walks the layout one access at a time. Each property access either
// returns a sub-proxy (for composite types — structs, mappings, arrays at
// roots and intermediate indices) or performs a slot read + decode (for leaf
// types — value types and `bytes`/`string`). Slot reads go through an
// app-supplied `get` callback so this package stays decoupled from any
// particular storage backend (revm sidecar, eth_getStorageAt, in-memory map,
// fixture, …).
//
// The `get` callback's return type drives sync vs async behaviour: if it
// returns a plain `SlotMap`, leaf reads return decoded values directly; if it
// returns `Promise<SlotMap>`, leaf reads return promises and any intermediate
// multi-slot reads (`bytes` long-form, `string` long-form) chain through
// `.then`. Composite access — `state.metadata`, `state.balances`, etc. —
// always returns a sub-proxy synchronously regardless.
//
// ## Out of scope, intentionally left for follow-ups
//
// 1. **Caching.** Every read calls `get` for the slots it needs; there's no
//    in-proxy cache. Future shape: thread an optional `cache` object through
//    `createStorageProxy` plus an `invalidate(slots: Hex[])` callback so the
//    runtime can bust entries when it sees revm `slot_writes`. The proxy
//    should consult the cache before calling `get` and populate it on read.
// 2. **Writing.** The proxy is strictly read-only. The `set` trap throws.
//    Future shape: accept a second optional callback like
//    `set: (writes: SlotWrites) => void | Promise<void>`,
//    and let `state.balances[addr] = 5n` route through `encodeStorageVariable` to
//    produce the writes. The encode side already exists in this package; the
//    missing bits are the proxy trap and the stale-slot policy for shrinking
//    bytes/string/dynamic arrays.

import { Hash, type Hex } from "ox";
import { decodeStorageVariable } from "./decodeStorageVariable";
import {
  fixedArrayLength,
  resolveStoragePath,
  type StorageItem,
  type StorageLayout,
  type StorageLayoutToPrimitiveType,
  type StorageType,
} from "./storage-layout";
import {
  formatStoragePath,
  HEX_STRING_PATTERN,
  normalizePath,
  type StoragePath,
  type StoragePathSegment,
  type StoragePathSubscript,
} from "./storage-path";
import type { AccountStorage } from "./types";

// -----------------------------------------------------------------------------
// Public types

/** Map of storage slot hex strings to their raw 32-byte values. */
type SlotMap = { [slot: Hex.Hex]: Hex.Hex };

/** Synchronous slot reader. */
type SyncSlotGetter = (slots: Hex.Hex[]) => SlotMap;
/** Asynchronous slot reader. */
type AsyncSlotGetter = (slots: Hex.Hex[]) => Promise<SlotMap>;
/** Sync or async slot reader. */
type SlotGetter = SyncSlotGetter | AsyncSlotGetter;

type StorageProxyValue<T, isAsync extends boolean> = [T] extends [
  readonly unknown[],
]
  ? number extends T["length"]
    ? T extends readonly (infer Element)[]
      ? DynamicArrayProxy<Element, isAsync>
      : never
    : { readonly [K in keyof T]: StorageProxyValue<T[K], isAsync> }
  : [T] extends [object]
    ? { readonly [K in keyof T]: StorageProxyValue<T[K], isAsync> }
    : isAsync extends true
      ? Promise<T>
      : T;

type DynamicArrayProxy<Element, isAsync extends boolean> = {
  readonly [index: number]: StorageProxyValue<Element, isAsync>;
  readonly length: isAsync extends true ? Promise<number> : number;
};

/**
 * Inferred shape of the proxy returned by {@link createStorageProxy}. The
 * structural shape mirrors {@link StorageLayoutToPrimitiveType}; when the
 * getter is asynchronous, leaf positions are wrapped in `Promise<>`. Dynamic
 * array `.length` is also a storage read, so async-backed proxies expose it as
 * `Promise<number>`. The whole projection is recursively readonly because proxy
 * writes are rejected.
 */
export type StorageProxy<
  L extends StorageLayout,
  isAsync extends boolean,
> = StorageProxyValue<StorageLayoutToPrimitiveType<L>, isAsync>;

const decodeStorageVariableRuntime = decodeStorageVariable as (
  layout: StorageLayout,
  path: string,
  storage: AccountStorage,
) => unknown;

// -----------------------------------------------------------------------------
// Public API

/**
 * Build a lazy, read-only JS-object projection over a Solidity storage
 * layout. Slot reads route through `get`; intermediate composite reads
 * return sub-proxies. Throws on unknown variables, unknown struct fields,
 * subscript access on non-indexable paths, and unsupported value/key types.
 *
 * The proxy supports declared-property access, numeric array indices, array
 * `.length`, and finite enumeration. Mapping enumeration only includes keys
 * present in `knownPaths`. The JS interop names `then`,
 * `catch`, `finally`, `toJSON`, and `asymmetricMatch` are reserved so
 * await/JSON/test-framework probes treat sub-proxies like plain objects; state
 * variables with those exact labels are not reachable through proxy property
 * access.
 *
 * @example
 * ```ts
 * const state = createStorageProxy(layout, (slots) => fetchSlots(slots));
 * const balance = state.balances["0x…"]; // bigint
 * const lastUpdate = state.metadata.lastUpdate; // bigint
 * ```
 *
 * @example async
 * ```ts
 * const state = createStorageProxy(layout, async (slots) =>
 *   sidecar.getStorage(slots),
 * );
 * const balance = await state.balances["0x…"]; // Promise<bigint>
 * ```
 */
export function createStorageProxy<
  L extends StorageLayout,
  G extends SlotGetter,
>(
  layout: L,
  get: G,
  knownVariables: readonly string[] = [],
): StorageProxy<L, G extends AsyncSlotGetter ? true : false> {
  let knownPathIndex = buildKnownPathIndex(knownVariables);
  let indexedKnownPathCount = knownVariables.length;
  const knownPaths = () => {
    if (knownVariables.length < indexedKnownPathCount) {
      // Shrink: rebuild from scratch, carrying the version forward so any proxy
      // key memo built against the previous index recomputes instead of serving
      // stale keys.
      const nextVersion = knownPathIndex.version + 1;
      knownPathIndex = buildKnownPathIndex(knownVariables);
      knownPathIndex.version = nextVersion;
    } else if (knownVariables.length > indexedKnownPathCount) {
      indexKnownPaths(knownPathIndex, knownVariables, indexedKnownPathCount);
      knownPathIndex.version += 1;
    }
    indexedKnownPathCount = knownVariables.length;
    return knownPathIndex;
  };
  return buildProxy(layout, get, knownPaths, null) as StorageProxy<
    L,
    G extends AsyncSlotGetter ? true : false
  >;
}

// -----------------------------------------------------------------------------
// Internals

// JS-protocol property names the runtime probes by name rather than via
// Symbols. Returning undefined for these makes the proxy behave like a plain
// object for `await` (treated as already-resolved, not a thenable), for
// JSON.stringify (no `.toJSON` shortcut), and for Bun/Jest matcher detection.
// Domain access only collides with these by accident; if an app declares a
// state variable literally named `then`, they can still reach it via the
// declared-paths layer instead of property access.
const JS_INTEROP_PROPS = new Set([
  "then",
  "catch",
  "finally",
  "toJSON",
  "asymmetricMatch",
]);

function buildProxy(
  layout: StorageLayout,
  get: SlotGetter,
  knownPaths: () => KnownPathIndex,
  path: StoragePath | null,
): object {
  // Memoize this path's enumerable keys (plus a membership Set) so that
  // `Object.keys` / `for…in` / spread stay O(k) rather than O(k²). The engine
  // calls `ownKeys` once and then `getOwnPropertyDescriptor` once per key;
  // without this cache every descriptor probe would rebuild and rescan the full
  // key list. The cache is keyed on the known-path index version, so it drops
  // as soon as mapping children grow (or the index is rebuilt on shrink).
  let memoVersion = -1;
  let memoKeys: string[] = [];
  let memoKeySet: Set<string> | null = null;
  const enumerable = (): { keys: string[]; set: Set<string> } => {
    const { version } = knownPaths();
    if (memoKeySet === null || version !== memoVersion) {
      memoKeys = enumerableKeys(layout, knownPaths, path);
      memoKeySet = new Set(memoKeys);
      memoVersion = version;
    }
    return { keys: memoKeys, set: memoKeySet };
  };

  return new Proxy(Object.create(null), {
    get(_, prop) {
      // Symbol property access (Symbol.toPrimitive, util.inspect.custom,
      // Symbol.iterator, etc.) returns undefined so the proxy interops with
      // logging, equality, iteration probes, and the Promises ecosystem.
      if (typeof prop !== "string") return undefined;
      if (JS_INTEROP_PROPS.has(prop)) return undefined;

      if (path === null) {
        // Root access: prop is a top-level storage variable name.
        const item = findVariable(layout, prop);
        const next: StoragePath = { root: item.label, segments: [] };
        return resolveOrSubProxy(layout, get, knownPaths, next);
      }

      // Sub-proxy access: build a new path segment by interpreting `prop`
      // against the storage type at the current path.
      const parentType = typeAtPath(layout, path);
      if (prop === "length" && parentType.base !== undefined) {
        return readArrayLength(layout, get, path, parentType);
      }
      const segment = makeSegment(layout, parentType, prop, path);
      const next: StoragePath = {
        root: path.root,
        segments: [...path.segments, segment],
      };
      return resolveOrSubProxy(layout, get, knownPaths, next);
    },

    set(_, prop) {
      throw new Error(
        `storage proxy is read-only (attempted set: ${String(prop)})`,
      );
    },

    has(_, prop) {
      if (typeof prop !== "string" || JS_INTEROP_PROPS.has(prop)) return false;
      return enumerable().set.has(prop);
    },

    ownKeys() {
      return enumerable().keys;
    },

    getOwnPropertyDescriptor(_, prop) {
      if (typeof prop === "string" && enumerable().set.has(prop)) {
        return { configurable: true, enumerable: true };
      }
      return undefined;
    },
  });
}

function resolveOrSubProxy(
  layout: StorageLayout,
  get: SlotGetter,
  knownPaths: () => KnownPathIndex,
  path: StoragePath,
): unknown {
  const type = typeAtPath(layout, path);
  if (isLeafType(type)) return readLeaf(layout, get, path);
  return buildProxy(layout, get, knownPaths, path);
}

function enumerableKeys(
  layout: StorageLayout,
  knownPaths: () => KnownPathIndex,
  path: StoragePath | null,
): string[] {
  if (path === null) return layout.storage.map((item) => item.label);

  const type = typeAtPath(layout, path);
  if (type.members !== undefined)
    return type.members.map((member) => member.label);
  if (type.base !== undefined && type.encoding === "inplace") {
    return Array.from({ length: fixedArrayLength(type) }, (_, index) =>
      String(index),
    );
  }
  if (type.base !== undefined) return [];
  if (type.key !== undefined) return knownChildProperties(knownPaths(), path);
  return [];
}

function knownChildProperties(
  knownPathIndex: KnownPathIndex,
  path: StoragePath,
): string[] {
  return [...(knownPathIndex.keysByPrefix.get(formatStoragePath(path)) ?? [])];
}

type KnownPathIndex = {
  keysByPrefix: Map<string, string[]>;
  seenKeysByPrefix: Map<string, Set<string>>;
  // Monotonic counter bumped whenever the indexed known paths change. Proxy key
  // memos compare against it to know when to recompute.
  version: number;
};

function buildKnownPathIndex(
  knownVariables: readonly string[],
): KnownPathIndex {
  const index: KnownPathIndex = {
    keysByPrefix: new Map<string, string[]>(),
    seenKeysByPrefix: new Map<string, Set<string>>(),
    version: 0,
  };
  indexKnownPaths(index, knownVariables, 0);
  return index;
}

function indexKnownPaths(
  index: KnownPathIndex,
  knownVariables: readonly string[],
  start: number,
): void {
  for (let index_ = start; index_ < knownVariables.length; index_++) {
    const knownPath = normalizePath(knownVariables[index_]!);
    for (let depth = 0; depth < knownPath.segments.length; depth++) {
      const next = knownPath.segments[depth]!;
      if (next.kind !== "subscript") continue;

      const prefix = formatStoragePath({
        root: knownPath.root,
        segments: knownPath.segments.slice(0, depth),
      });
      const key = formatSubscript(next.value);
      let seenKeys = index.seenKeysByPrefix.get(prefix);
      if (seenKeys === undefined) {
        seenKeys = new Set();
        index.seenKeysByPrefix.set(prefix, seenKeys);
        index.keysByPrefix.set(prefix, []);
      }
      if (seenKeys.has(key)) continue;
      seenKeys.add(key);
      index.keysByPrefix.get(prefix)!.push(key);
    }
  }
}

// Walk a path through the layout's types and return the type at its terminus.
// Differs from `resolveStoragePath` in that it doesn't expand composite types
// into per-leaf slot entries; it returns the type sitting at the end of the
// path so the proxy can decide whether to recurse or read.
function typeAtPath(layout: StorageLayout, path: StoragePath): StorageType {
  const item = findVariable(layout, path.root);
  let type = findType(layout, item.type);

  for (let i = 0; i < path.segments.length; i++) {
    const segment = path.segments[i]!;
    const prefixPath: StoragePath = {
      root: path.root,
      segments: path.segments.slice(0, i),
    };
    if (segment.kind === "field") {
      if (type.members === undefined) {
        throw new Error(
          `cannot access field '${segment.name}' on non-struct path '${formatStoragePath(prefixPath)}' (type='${type.label}')`,
        );
      }
      const member = type.members.find((m) => m.label === segment.name);
      if (member === undefined) {
        throw new Error(
          `struct field not found: '${segment.name}' on '${formatStoragePath(prefixPath)}' (type='${type.label}')`,
        );
      }
      type = findType(layout, member.type);
      continue;
    }

    if (type.base !== undefined) {
      // Fixed or dynamic array.
      type = findType(layout, type.base);
      continue;
    }
    if (type.key !== undefined && type.value !== undefined) {
      type = findType(layout, type.value);
      continue;
    }

    throw new Error(
      `cannot subscript non-indexable path '${formatStoragePath(prefixPath)}' (type='${type.label}')`,
    );
  }

  return type;
}

function findVariable(layout: StorageLayout, label: string): StorageItem {
  const item = layout.storage.find((candidate) => candidate.label === label);
  if (item === undefined) {
    throw new Error(`unknown storage variable: '${label}'`);
  }
  return item;
}

function findType(layout: StorageLayout, typeId: string): StorageType {
  const type = layout.types[typeId];
  if (type === undefined) {
    throw new Error(`unknown storage type: '${typeId}'`);
  }
  return type;
}

function isLeafType(type: StorageType): boolean {
  return isValueType(type) || isBytesType(type);
}

function isValueType(type: StorageType): boolean {
  if (type.encoding !== "inplace" || type.members !== undefined) return false;
  return (
    /^u?int[0-9]*$/.test(type.label) ||
    type.label === "address" ||
    type.label === "bool" ||
    /^bytes([1-9]|[12][0-9]|3[0-2])$/.test(type.label) ||
    type.label.startsWith("enum ")
  );
}

function isBytesType(type: StorageType): boolean {
  return type.encoding === "bytes";
}

// -----------------------------------------------------------------------------
// Segment construction

function makeSegment(
  layout: StorageLayout,
  parentType: StorageType,
  prop: string,
  parentPath: StoragePath,
): StoragePathSegment {
  if (parentType.members !== undefined) {
    // Struct: prop must be a declared field name. Existence will be
    // re-checked by `typeAtPath` later, but a precise message here points
    // at the bad access site.
    const member = parentType.members.find((m) => m.label === prop);
    if (member === undefined) {
      throw new Error(
        `unknown struct field '${prop}' on '${formatStoragePath(parentPath)}' (type='${parentType.label}')`,
      );
    }
    return { kind: "field", name: prop };
  }

  if (parentType.base !== undefined) {
    // Fixed or dynamic array: prop must be a non-negative decimal integer.
    return {
      kind: "subscript",
      value: { kind: "number", value: parseArrayIndex(prop, parentPath) },
    };
  }

  if (parentType.key !== undefined) {
    // Mapping: prop is a key. Interpret the literal based on the declared
    // Solidity key type so slot resolution can hash it correctly.
    const keyType = findType(layout, parentType.key);
    return {
      kind: "subscript",
      value: subscriptForKey(keyType, prop, parentPath),
    };
  }

  throw new Error(
    `cannot access property '${prop}' on leaf path '${formatStoragePath(parentPath)}' (type='${parentType.label}')`,
  );
}

function readArrayLength(
  layout: StorageLayout,
  get: SlotGetter,
  path: StoragePath,
  type: StorageType,
): unknown {
  if (type.encoding === "inplace") return fixedArrayLength(type);
  const resolved = resolveStoragePath(layout, path);
  if (resolved.length !== 1) {
    throw new Error(
      `dynamic array path did not resolve to one length slot: ${formatStoragePath(path)}`,
    );
  }
  const slot = slotHex(resolved[0]!);
  return chain(get([slot]), (storage) => {
    const value = slotValue(storage, slot);
    if (value === undefined) {
      throw new Error(
        `getter did not return dynamic array length slot for ${formatStoragePath(path)}: ${slot}`,
      );
    }
    const length = BigInt(value);
    if (length > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error(
        `dynamic array length is too large at ${formatStoragePath(path)}: length=${length}`,
      );
    }
    return Number(length);
  });
}

function parseArrayIndex(prop: string, parentPath: StoragePath): bigint {
  if (!/^(0|[1-9][0-9]*)$/.test(prop)) {
    throw new Error(
      `array index on '${formatStoragePath(parentPath)}' must be a non-negative decimal integer: '${prop}'`,
    );
  }
  return BigInt(prop);
}

function subscriptForKey(
  keyType: StorageType,
  prop: string,
  parentPath: StoragePath,
): StoragePathSubscript {
  const label = keyType.label;
  if (label === "address") {
    if (!HEX_STRING_PATTERN.test(prop)) {
      throw new Error(
        `mapping key on '${formatStoragePath(parentPath)}' must be a hex string for key type '${label}': '${prop}'`,
      );
    }
    return { kind: "hex", value: prop as Hex.Hex };
  }
  if (label === "bool") {
    if (prop === "true" || prop === "false") {
      return { kind: "bool", value: prop === "true" };
    }
    throw new Error(
      `mapping key on '${formatStoragePath(parentPath)}' must be 'true' or 'false' for key type '${label}': '${prop}'`,
    );
  }
  if (/^u?int[0-9]*$/.test(label)) {
    if (!/^-?(0|[1-9][0-9]*)$/.test(prop)) {
      throw new Error(
        `mapping key on '${formatStoragePath(parentPath)}' must be a decimal integer for key type '${label}': '${prop}'`,
      );
    }
    return { kind: "number", value: BigInt(prop) };
  }
  if (/^bytes([1-9]|[12][0-9]|3[0-2])$/.test(label)) {
    if (!HEX_STRING_PATTERN.test(prop)) {
      throw new Error(
        `mapping key on '${formatStoragePath(parentPath)}' must be a hex string for key type '${label}': '${prop}'`,
      );
    }
    return { kind: "hex", value: prop as Hex.Hex };
  }
  throw new Error(
    `unsupported mapping key type '${label}' on '${formatStoragePath(parentPath)}'`,
  );
}

// -----------------------------------------------------------------------------
// Leaf reads

// Bytes/string header: low byte's low bit distinguishes short (data inline,
// length = lowByte/2) from long (length = (header-1)/2, data at
// keccak256(slot) + i).
const BYTES_LOW_BIT_MASK = 0x01n;
const BYTES_LOW_BYTE_MASK = 0xffn;

function readLeaf(
  layout: StorageLayout,
  get: SlotGetter,
  path: StoragePath,
): unknown {
  const type = typeAtPath(layout, path);
  if (isBytesType(type)) return readBytesLeaf(layout, get, path);
  return readValueLeaf(layout, get, path);
}

function readValueLeaf(
  layout: StorageLayout,
  get: SlotGetter,
  path: StoragePath,
): unknown {
  // Value-type leaves resolve to a single slot. `resolveStoragePath` is the
  // canonical source of slot positions including packed offsets.
  const resolved = resolveStoragePath(layout, path);
  const slots = uniqueSlots(resolved);
  return chain(get(slots), (storage) => {
    assertReturnedSlots(storage, slots, formatStoragePath(path));
    return decodeStorageVariableRuntime(
      layout,
      formatStoragePath(path),
      storage,
    );
  });
}

function readBytesLeaf(
  layout: StorageLayout,
  get: SlotGetter,
  path: StoragePath,
): unknown {
  const resolved = resolveStoragePath(layout, path);
  if (resolved.length !== 1) {
    throw new Error(
      `bytes/string path did not resolve to a single header slot: ${formatStoragePath(path)}`,
    );
  }
  const headerSlot = slotHex(resolved[0]!);
  return chain(get([headerSlot]), (header) => {
    const headerValue = slotValue(header, headerSlot);
    if (headerValue === undefined) {
      throw new Error(
        `getter did not return header slot for ${formatStoragePath(path)}: ${headerSlot}`,
      );
    }
    const headerInt = BigInt(headerValue);
    const lowByte = headerInt & BYTES_LOW_BYTE_MASK;
    if ((lowByte & BYTES_LOW_BIT_MASK) === 0n) {
      // Short form — header carries the data.
      return decodeStorageVariableRuntime(
        layout,
        formatStoragePath(path),
        header,
      );
    }
    const length = (headerInt - 1n) / 2n;
    if (length > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error(
        `bytes/string too large to decode at ${formatStoragePath(path)}: length=${length}`,
      );
    }
    const dataBaseSlot = keccakSlot(headerSlot);
    const numDataSlots = Math.ceil(Number(length) / 32);
    const dataSlots: Hex.Hex[] = [];
    for (let i = 0; i < numDataSlots; i++) {
      dataSlots.push(addSlot(dataBaseSlot, BigInt(i)));
    }
    return chain(get(dataSlots), (data) => {
      assertReturnedSlots(data, dataSlots, formatStoragePath(path));
      return decodeStorageVariableRuntime(layout, formatStoragePath(path), {
        ...header,
        ...data,
      });
    });
  });
}

function assertReturnedSlots(
  storage: SlotMap,
  slots: readonly Hex.Hex[],
  path: string,
): void {
  for (const slot of slots) {
    if (slotValue(storage, slot) === undefined) {
      throw new Error(`getter did not return slot for ${path}: ${slot}`);
    }
  }
}

function slotValue(
  storage: SlotMap,
  requestedSlot: Hex.Hex,
): Hex.Hex | undefined {
  const requested = BigInt(requestedSlot);
  for (const [slot, value] of Object.entries(storage)) {
    if (BigInt(slot) === requested) return value as Hex.Hex;
  }
  return undefined;
}

// Apply `f` synchronously if `value` is not a Promise; otherwise schedule
// it on the promise chain. Lets the same code path serve both sync and async
// getters.
function chain<T, R>(
  value: T | Promise<T>,
  f: (resolved: T) => R | Promise<R>,
): R | Promise<R> {
  if (isPromise(value)) {
    return value.then((v) => f(v));
  }
  return f(value);
}

function isPromise<T>(v: unknown): v is Promise<T> {
  return (
    v !== null &&
    typeof v === "object" &&
    typeof (v as { then?: unknown }).then === "function"
  );
}

function uniqueSlots(
  resolved: readonly { baseSlot: bigint; item: { slot: string } }[],
): Hex.Hex[] {
  const seen = new Set<string>();
  const out: Hex.Hex[] = [];
  for (const r of resolved) {
    const slot = slotHex(r);
    if (seen.has(slot)) continue;
    seen.add(slot);
    out.push(slot);
  }
  return out;
}

function slotHex(resolved: {
  baseSlot: bigint;
  item: { slot: string };
}): Hex.Hex {
  return toSlotHex(resolved.baseSlot + BigInt(resolved.item.slot));
}

function addSlot(base: bigint, offset: bigint): Hex.Hex {
  return toSlotHex(base + offset);
}

function toSlotHex(value: bigint): Hex.Hex {
  return `0x${value.toString(16).padStart(64, "0")}` as Hex.Hex;
}

function keccakSlot(slot: Hex.Hex): bigint {
  return BigInt(Hash.keccak256(slot));
}

function formatSubscript(subscript: StoragePathSubscript): string {
  switch (subscript.kind) {
    case "number":
      return subscript.value.toString();
    case "hex":
      return subscript.value;
    case "string":
      return subscript.value;
    case "bool":
      return String(subscript.value);
  }
}
