import { expect, test } from "bun:test";
import type { Hex } from "ox";
import {
  complexLayout,
  layout,
  METADATA_PACKED,
  OWNER,
  PACKED_OWNER_PAUSED,
  SALT,
} from "../test/utils";
import type { StorageLayout } from "./index";
import { createStorageProxy, encodeStorage, getStorageSlot } from "./index";

const SPENDER = "0x2222222222222222222222222222222222221234" as const;
const PACKED_FIXED_NUMBERS =
  "0x0000000000000000000000000000000200000000000000000000000000000001" as Hex.Hex;

// -----------------------------------------------------------------------------
// Test helpers

type SlotMap = { [slot: Hex.Hex]: Hex.Hex };

/** Build a sync getter that pulls slots from a fixed in-memory map, records
 * every call for assertions, and throws on unknown slots so tests don't
 * silently accept missing data. */
function syncGetter(storage: SlotMap) {
  const calls: Hex.Hex[][] = [];
  const get = (slots: Hex.Hex[]): SlotMap => {
    calls.push(slots);
    const out: SlotMap = {};
    for (const slot of slots) {
      const value = storage[slot];
      if (value === undefined) {
        throw new Error(`test getter: missing slot ${slot}`);
      }
      out[slot] = value;
    }
    return out;
  };
  return { get, calls };
}

/** Async equivalent of `syncGetter`. Resolves on the next microtask. */
function asyncGetter(storage: SlotMap) {
  const calls: Hex.Hex[][] = [];
  const get = async (slots: Hex.Hex[]): Promise<SlotMap> => {
    calls.push(slots);
    await Promise.resolve();
    const out: SlotMap = {};
    for (const slot of slots) {
      const value = storage[slot];
      if (value === undefined) {
        throw new Error(`test getter: missing slot ${slot}`);
      }
      out[slot] = value;
    }
    return out;
  };
  return { get, calls };
}

function writesToStorage(writes: { slot: Hex.Hex; value: Hex.Hex }[]): SlotMap {
  return Object.fromEntries(writes.map((w) => [w.slot, w.value]));
}

// -----------------------------------------------------------------------------
// Sync mode

test("sync: reads top-level value-type variables", () => {
  const { get, calls } = syncGetter({
    "0x0000000000000000000000000000000000000000000000000000000000000000":
      "0x2a",
    "0x0000000000000000000000000000000000000000000000000000000000000001":
      PACKED_OWNER_PAUSED,
    "0x0000000000000000000000000000000000000000000000000000000000000002":
      "0xffff",
    "0x0000000000000000000000000000000000000000000000000000000000000003": SALT,
  });
  const state = createStorageProxy(layout, get);

  expect(state.totalSupply).toBe(42n);
  expect(state.owner).toBe(OWNER);
  expect(state.paused).toBe(true);
  expect(state.debt).toBe(-1);
  expect(state.salt).toBe(SALT);
  expect(calls.length).toBe(5);
});

test("sync: packed slot reads share the same backing slot", () => {
  // `owner` and `paused` live in slot 1 (offset 0 and 20 bytes respectively).
  // Each read fetches that slot; the proxy doesn't cache, so two separate
  // calls are issued — but both pull the same slot hex.
  const { get, calls } = syncGetter({
    "0x0000000000000000000000000000000000000000000000000000000000000001":
      PACKED_OWNER_PAUSED,
  });
  const state = createStorageProxy(layout, get);

  expect(state.owner).toBe(OWNER);
  expect(state.paused).toBe(true);
  expect(calls).toEqual([
    ["0x0000000000000000000000000000000000000000000000000000000000000001"],
    ["0x0000000000000000000000000000000000000000000000000000000000000001"],
  ]);
});

test("sync: struct field access lazily reads only the field's slot", () => {
  const { get, calls } = syncGetter({
    "0x0000000000000000000000000000000000000000000000000000000000000004":
      METADATA_PACKED,
  });
  const state = createStorageProxy(layout, get);

  expect(state.metadata.lastUpdate).toBe(42n);
  expect(state.metadata.active).toBe(true);
  // Only slot 4 fetched; struct fields admin (slot 5) and inner.count (slot
  // 6) are untouched.
  expect(calls.length).toBe(2);
  for (const call of calls) {
    expect(call).toEqual([
      "0x0000000000000000000000000000000000000000000000000000000000000004",
    ]);
  }
});

test("sync: nested struct fields traverse through composite sub-proxies", () => {
  const { get } = syncGetter({
    "0x0000000000000000000000000000000000000000000000000000000000000006":
      "0x7b",
  });
  const state = createStorageProxy(layout, get);

  expect(state.metadata.inner.count).toBe(123n);
});

test("sync: composite access returns a sub-proxy you can hold", () => {
  const { get } = syncGetter({
    "0x0000000000000000000000000000000000000000000000000000000000000004":
      METADATA_PACKED,
  });
  const state = createStorageProxy(layout, get);
  const metadata = state.metadata;

  expect(metadata.lastUpdate).toBe(42n);
  expect(metadata.active).toBe(true);
});

test("sync: fixed array element reads one slot, decodes the packed half", () => {
  const { get, calls } = syncGetter({
    "0x0000000000000000000000000000000000000000000000000000000000000008":
      PACKED_FIXED_NUMBERS,
  });
  const state = createStorageProxy(layout, get);

  expect(state.fixedNumbers[0]).toBe(1n);
  expect(state.fixedNumbers[1]).toBe(2n);
  expect(calls.length).toBe(2);
});

test("sync: dynamic array element reads from its keccak-derived slot", () => {
  const elementSlot = getStorageSlot(layout, "dynamicNumbers[0]");
  const { get } = syncGetter({ [elementSlot]: "0x539" });
  const state = createStorageProxy(layout, get);

  expect(state.dynamicNumbers[0]).toBe(1337n);
});

test("sync: mapping with address key", () => {
  const balanceSlot = getStorageSlot(layout, `balances[${OWNER}]`);
  const { get } = syncGetter({ [balanceSlot]: "0x64" });
  const state = createStorageProxy(layout, get);

  expect(state.balances[OWNER]).toBe(100n);
});

test("sync: nested mapping unwraps one key at a time", () => {
  const allowanceSlot = getStorageSlot(
    layout,
    `allowances[${OWNER}][${SPENDER}]`,
  );
  const { get } = syncGetter({ [allowanceSlot]: "0x2a" });
  const state = createStorageProxy(layout, get);

  expect(state.allowances[OWNER]![SPENDER]).toBe(42n);
});

test("sync: short bytes decodes from header alone (one round-trip)", () => {
  const writes = encodeStorage(layout, "rawBytes", "0x1234");
  const { get, calls } = syncGetter(writesToStorage(writes));
  const state = createStorageProxy(layout, get);

  expect(state.rawBytes).toBe("0x1234");
  expect(calls.length).toBe(1);
});

test("sync: long bytes reads header, then data slots", () => {
  const longBytes = `0x${"11".repeat(33)}` as Hex.Hex;
  const writes = encodeStorage(layout, "rawBytes", longBytes);
  const { get, calls } = syncGetter(writesToStorage(writes));
  const state = createStorageProxy(layout, get);

  expect(state.rawBytes).toBe(longBytes);
  expect(calls.length).toBe(2);
  // First call: header slot. Second call: data slots (two for 33 bytes).
  expect(calls[0]?.length).toBe(1);
  expect(calls[1]?.length).toBe(2);
});

test("sync: short string decodes from header alone", () => {
  const writes = encodeStorage(layout, "message", "hello");
  const { get } = syncGetter(writesToStorage(writes));
  const state = createStorageProxy(layout, get);

  expect(state.message).toBe("hello");
});

test("sync: long string reads header, then data slots", () => {
  const long = "x".repeat(33);
  const writes = encodeStorage(layout, "message", long);
  const { get, calls } = syncGetter(writesToStorage(writes));
  const state = createStorageProxy(layout, get);

  expect(state.message).toBe(long);
  expect(calls.length).toBe(2);
});

test("sync: composite path containing nested arrays + structs", () => {
  const slot = getStorageSlot(complexLayout, "orders[1].amount");
  const { get } = syncGetter({ [slot]: "0x9" });
  const state = createStorageProxy(complexLayout, get);

  expect(state.orders[1]!.amount).toBe(9n);
});

test("sync: arrays of arrays index by both subscripts", () => {
  const slot = getStorageSlot(complexLayout, "matrix[1][0]");
  // matrix[1][0] is a uint128 packed in the low half of slot 0x15.
  const { get } = syncGetter({
    [slot]:
      "0x000000000000000000000000000000000000000000000000000000000000002a",
  });
  const state = createStorageProxy(complexLayout, get);

  expect(state.matrix[1]![0]).toBe(42n);
});

// -----------------------------------------------------------------------------
// Async mode

test("async: returns promises at leaves", async () => {
  const { get } = asyncGetter({
    "0x0000000000000000000000000000000000000000000000000000000000000000":
      "0xff",
  });
  const state = createStorageProxy(layout, get);

  const supply = state.totalSupply;
  expect(supply).toBeInstanceOf(Promise);
  expect(await supply).toBe(255n);
});

test("async: nested mapping awaited per leaf", async () => {
  const allowanceSlot = getStorageSlot(
    layout,
    `allowances[${OWNER}][${SPENDER}]`,
  );
  const { get, calls } = asyncGetter({ [allowanceSlot]: "0x14" });
  const state = createStorageProxy(layout, get);

  // Intermediate accesses (allowances, allowances[OWNER]) are synchronous
  // sub-proxies; only the leaf read awaits.
  const value = state.allowances[OWNER]![SPENDER];
  expect(value).toBeInstanceOf(Promise);
  expect(await value).toBe(20n);
  expect(calls).toEqual([[allowanceSlot]]);
});

test("async: long bytes performs two sequential rounds", async () => {
  const longBytes = `0x${"22".repeat(40)}` as Hex.Hex;
  const writes = encodeStorage(layout, "rawBytes", longBytes);
  const { get, calls } = asyncGetter(writesToStorage(writes));
  const state = createStorageProxy(layout, get);

  expect(await state.rawBytes).toBe(longBytes);
  expect(calls.length).toBe(2);
});

test("async: composite access is still synchronous (sub-proxy creation)", () => {
  const { get } = asyncGetter({});
  const state = createStorageProxy(layout, get);

  // Reading `state.metadata` doesn't await — it's a sub-proxy. Only
  // accessing a leaf below would issue a fetch.
  const metadata = state.metadata;
  expect(metadata).not.toBeInstanceOf(Promise);
});

// -----------------------------------------------------------------------------
// Edge cases & error handling

test("throws on unknown top-level variable", () => {
  const { get } = syncGetter({});
  // biome-ignore lint/suspicious/noExplicitAny: testing untyped runtime access
  const state = createStorageProxy(layout, get) as any;

  expect(() => state.notARealVariable).toThrow(
    "unknown storage variable: 'notARealVariable'",
  );
});

test("throws on unknown struct field", () => {
  const { get } = syncGetter({});
  // biome-ignore lint/suspicious/noExplicitAny: testing untyped runtime access
  const state = createStorageProxy(layout, get) as any;

  expect(() => state.metadata.notAField).toThrow(
    "unknown struct field 'notAField' on 'metadata'",
  );
});

test("throws on subscript against a non-indexable struct path", () => {
  const { get } = syncGetter({});
  // biome-ignore lint/suspicious/noExplicitAny: testing untyped runtime access
  const state = createStorageProxy(layout, get) as any;

  // `metadata` is a struct; bracket-indexing it with anything that doesn't
  // match a field name should throw with the struct's name in the message.
  expect(() => state.metadata["0xabcd"]).toThrow(
    "unknown struct field '0xabcd' on 'metadata'",
  );
});

test("throws on field access against an array path", () => {
  const { get } = syncGetter({});
  // biome-ignore lint/suspicious/noExplicitAny: testing untyped runtime access
  const state = createStorageProxy(layout, get) as any;

  expect(() => state.fixedNumbers.notAField).toThrow(
    "array index on 'fixedNumbers' must be a non-negative decimal integer: 'notAField'",
  );
});

test("throws on malformed array index", () => {
  const { get } = syncGetter({});
  // biome-ignore lint/suspicious/noExplicitAny: testing untyped runtime access
  const state = createStorageProxy(layout, get) as any;

  expect(() => state.dynamicNumbers["-1"]).toThrow(
    "array index on 'dynamicNumbers' must be a non-negative decimal integer: '-1'",
  );
  expect(() => state.dynamicNumbers["1.5"]).toThrow(
    "array index on 'dynamicNumbers' must be a non-negative decimal integer: '1.5'",
  );
});

test("throws on malformed mapping key for address-keyed mapping", () => {
  const { get } = syncGetter({});
  // biome-ignore lint/suspicious/noExplicitAny: testing untyped runtime access
  const state = createStorageProxy(layout, get) as any;

  expect(() => state.balances.notHex).toThrow(
    "mapping key on 'balances' must be a hex string for key type 'address': 'notHex'",
  );
});

test("symbol property access returns undefined (doesn't throw)", () => {
  const { get } = syncGetter({});
  const state = createStorageProxy(layout, get);

  // biome-ignore lint/suspicious/noExplicitAny: probing internal symbols
  const anyState = state as any;
  expect(anyState[Symbol.iterator]).toBeUndefined();
  expect(anyState[Symbol.toPrimitive]).toBeUndefined();
});

test("Promise-interop probes return undefined (no domain throw)", async () => {
  // `await sub-proxy` triggers JS's thenable check (`.then` lookup). If
  // that lookup throws, await propagates the throw; we want it to surface
  // as "value isn't a thenable, treat as already-resolved" instead. Same
  // for JSON.stringify probing `.toJSON`.
  const { get } = syncGetter({
    "0x0000000000000000000000000000000000000000000000000000000000000004":
      METADATA_PACKED,
  });
  const state = createStorageProxy(layout, get);

  // biome-ignore lint/suspicious/noExplicitAny: probing protocol names
  const sub = state.metadata as any;
  expect(sub.then).toBeUndefined();
  expect(sub.catch).toBeUndefined();
  expect(sub.finally).toBeUndefined();
  expect(sub.toJSON).toBeUndefined();

  // Awaiting a sub-proxy works (returns the sub-proxy itself, unchanged).
  const awaited = await Promise.resolve(sub);
  expect(awaited.lastUpdate).toBe(42n);
});

test("reserved JS interop names are not reachable through proxy access", () => {
  const reservedLayout = {
    storage: [
      {
        astId: 1,
        contract: "src/Test.sol:Test",
        label: "then",
        offset: 0,
        slot: "0",
        type: "t_uint256",
      },
      {
        astId: 2,
        contract: "src/Test.sol:Test",
        label: "catch",
        offset: 0,
        slot: "1",
        type: "t_uint256",
      },
      {
        astId: 3,
        contract: "src/Test.sol:Test",
        label: "finally",
        offset: 0,
        slot: "2",
        type: "t_uint256",
      },
      {
        astId: 4,
        contract: "src/Test.sol:Test",
        label: "toJSON",
        offset: 0,
        slot: "3",
        type: "t_uint256",
      },
      {
        astId: 5,
        contract: "src/Test.sol:Test",
        label: "asymmetricMatch",
        offset: 0,
        slot: "4",
        type: "t_uint256",
      },
    ],
    types: {
      t_uint256: {
        encoding: "inplace",
        label: "uint256",
        numberOfBytes: "32",
      },
    },
  } as const satisfies StorageLayout;
  const { get } = syncGetter({});
  // biome-ignore lint/suspicious/noExplicitAny: testing reserved runtime names
  const state = createStorageProxy(reservedLayout, get) as any;

  expect(state.then).toBeUndefined();
  expect(state.catch).toBeUndefined();
  expect(state.finally).toBeUndefined();
  expect(state.toJSON).toBeUndefined();
  expect(state.asymmetricMatch).toBeUndefined();
});

test("array proxies only support numeric element access", () => {
  const { get } = syncGetter({});
  // biome-ignore lint/suspicious/noExplicitAny: testing array protocol access
  const state = createStorageProxy(layout, get) as any;

  expect(() => state.fixedNumbers[3]).toThrow(
    "fixed array index out of bounds: fixedNumbers[3]",
  );
  expect(() => state.fixedNumbers["9007199254740993"]).toThrow(
    "fixed array index out of bounds: fixedNumbers[9007199254740993]",
  );
  expect(() => state.fixedNumbers.length).toThrow(
    "array index on 'fixedNumbers' must be a non-negative decimal integer: 'length'",
  );
});

test("storage proxy is read-only: set throws", () => {
  const { get } = syncGetter({});
  // biome-ignore lint/suspicious/noExplicitAny: testing untyped runtime mutation
  const state = createStorageProxy(layout, get) as any;

  expect(() => {
    state.totalSupply = 1n;
  }).toThrow("storage proxy is read-only");
});

test("storage proxy refuses 'in' operator", () => {
  const { get } = syncGetter({});
  const state = createStorageProxy(layout, get);

  expect(() => "totalSupply" in state).toThrow(/'in' operator/);
});

test("storage proxy refuses enumeration", () => {
  const { get } = syncGetter({});
  const state = createStorageProxy(layout, get);

  expect(() => Object.keys(state)).toThrow(/enumeration/);
});

test("get is called with the exact slots resolved by storage-layout", () => {
  const slot4 = getStorageSlot(layout, "metadata.lastUpdate");
  const balanceSlot = getStorageSlot(layout, `balances[${OWNER}]`);
  const { get, calls } = syncGetter({
    [slot4]: METADATA_PACKED,
    [balanceSlot]: "0x7",
  });
  const state = createStorageProxy(layout, get);

  expect(state.metadata.lastUpdate).toBe(42n);
  expect(state.balances[OWNER]).toBe(7n);
  expect(calls).toEqual([[slot4], [balanceSlot]]);
});

test("throws when the getter omits a requested slot", () => {
  const get = (_: Hex.Hex[]): SlotMap => ({});
  const state = createStorageProxy(layout, get);

  expect(() => state.totalSupply).toThrow(/storage value not found for slot/);
});
