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
//    `set: (writes: { slot: Hex; value: Hex }[]) => void | Promise<void>`,
//    and let `state.balances[addr] = 5n` route through `encodeStorage` to
//    produce the writes. The encode side already exists in this package; the
//    missing bits are the proxy trap and the stale-slot policy for shrinking
//    bytes/string/dynamic arrays.
// 3. **Mapping enumeration.** Solidity storage cannot discover mapping keys
//    from slots alone, so enumeration requires a known-paths list supplied by
//    the app/runtime (subscriptions, calldata/event-derived keys, persisted
//    path registry, etc.). Future shape: pass that known-path universe into
//    `createStorageProxy` so `Object.keys(state.balances)` and similar APIs can
//    enumerate only keys the runtime already knows about.

import { Hash, type Hex } from "ox";
import {
  decodeStorage,
  type StorageLayout,
  type StorageLayoutToPrimitiveType,
} from "./index";
import {
  resolveStoragePath,
  type StorageItem,
  type StorageType,
} from "./storage-layout";
import {
  formatStoragePath,
  HEX_STRING_PATTERN,
  type StoragePath,
  type StoragePathSegment,
  type StoragePathSubscript,
} from "./storage-path";

// -----------------------------------------------------------------------------
// Public types

/** Map of storage slot hex strings to their raw 32-byte values. */
export type SlotMap = { [slot: Hex.Hex]: Hex.Hex };

/** Synchronous slot reader. */
export type SyncSlotGetter = (slots: Hex.Hex[]) => SlotMap;
/** Asynchronous slot reader. */
export type AsyncSlotGetter = (slots: Hex.Hex[]) => Promise<SlotMap>;
/** Sync or async slot reader. */
export type SlotGetter = SyncSlotGetter | AsyncSlotGetter;

/**
 * Recursively wrap every leaf value in `Promise<>`. Composite shapes
 * (objects, tuples, arrays) keep their structure; only the terminal primitive
 * positions become promises. Used to model an async-backed proxy's return
 * type.
 */
export type DeepPromise<T> = [T] extends [readonly unknown[]]
  ? { readonly [K in keyof T]: DeepPromise<T[K]> }
  : [T] extends [object]
    ? { [K in keyof T]: DeepPromise<T[K]> }
    : Promise<T>;

/**
 * Inferred shape of the proxy returned by {@link createStorageProxy}. The
 * structural shape mirrors {@link StorageLayoutToPrimitiveType}; when the
 * getter is asynchronous, leaf positions are wrapped in `Promise<>`.
 */
export type StorageProxy<
  L extends StorageLayout,
  G extends SlotGetter,
> = G extends AsyncSlotGetter
  ? DeepPromise<StorageLayoutToPrimitiveType<L>>
  : StorageLayoutToPrimitiveType<L>;

// -----------------------------------------------------------------------------
// Public API

/**
 * Build a lazy, read-only JS-object projection over a Solidity storage
 * layout. Slot reads route through `get`; intermediate composite reads
 * return sub-proxies. Throws on unknown variables, unknown struct fields,
 * subscript access on non-indexable paths, and unsupported value/key types.
 *
 * The proxy only supports direct declared-property access plus numeric array
 * indices. It cannot enumerate keys or expose array protocol metadata like
 * `.length`. The JS interop names `then`, `catch`, `finally`, `toJSON`, and
 * `asymmetricMatch` are reserved so await/JSON/test-framework probes treat
 * sub-proxies like plain objects; state variables with those exact labels are
 * not reachable through proxy property access.
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
>(layout: L, get: G): StorageProxy<L, G> {
  return buildProxy(layout, get, null) as StorageProxy<L, G>;
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
  path: StoragePath | null,
): object {
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
        return resolveOrSubProxy(layout, get, next);
      }

      // Sub-proxy access: build a new path segment by interpreting `prop`
      // against the storage type at the current path.
      const parentType = typeAtPath(layout, path);
      const segment = makeSegment(layout, parentType, prop, path);
      const next: StoragePath = {
        root: path.root,
        segments: [...path.segments, segment],
      };
      return resolveOrSubProxy(layout, get, next);
    },

    set(_, prop) {
      throw new Error(
        `storage proxy is read-only (attempted set: ${String(prop)})`,
      );
    },

    has() {
      throw new Error(
        "storage proxy does not support the 'in' operator (storage layout cannot enumerate mapping keys)",
      );
    },

    ownKeys() {
      throw new Error(
        "storage proxy does not support enumeration (storage layout cannot list mapping keys or dynamic-array bounds)",
      );
    },

    getOwnPropertyDescriptor() {
      // Keep the descriptor protocol consistent with the `ownKeys` trap.
      return undefined;
    },
  });
}

function resolveOrSubProxy(
  layout: StorageLayout,
  get: SlotGetter,
  path: StoragePath,
): unknown {
  const type = typeAtPath(layout, path);
  if (isLeafType(type)) return readLeaf(layout, get, path);
  return buildProxy(layout, get, path);
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
  return chain(get(slots), (storage) => decodeStorage(layout, path, storage));
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
    const headerValue = header[headerSlot];
    if (headerValue === undefined) {
      throw new Error(
        `getter did not return header slot for ${formatStoragePath(path)}: ${headerSlot}`,
      );
    }
    const headerInt = BigInt(headerValue);
    const lowByte = headerInt & BYTES_LOW_BYTE_MASK;
    if ((lowByte & BYTES_LOW_BIT_MASK) === 0n) {
      // Short form — header carries the data.
      return decodeStorage(layout, path, header);
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
    return chain(get(dataSlots), (data) =>
      decodeStorage(layout, path, { ...header, ...data }),
    );
  });
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
