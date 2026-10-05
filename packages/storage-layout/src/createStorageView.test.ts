import { expect, test } from "bun:test";
import { Hash, Hex } from "ox";
import {
  bytesStorage,
  complexLayout,
  layout,
  METADATA_PACKED,
  OWNER,
  PACKED_FIXED_NUMBERS,
  PACKED_OWNER_PAUSED,
  SALT,
  SPENDER,
  slotOf,
} from "../test/utils";
import {
  type AccountStorage,
  createStorageView,
  type KeccakPreimage,
  type StorageLayout,
} from "./index";

// -----------------------------------------------------------------------------
// Helpers

/**
 * A getter backed by an in-memory slot map. It records every call, and it
 * throws on a slot that is not in the map, so a test cannot pass by reading
 * slots it did not set up.
 */
function getter(storage: AccountStorage) {
  const calls: (readonly Hex.Hex[])[] = [];
  const read = (slots: readonly Hex.Hex[]): Hex.Hex[] => {
    calls.push(slots);
    return slots.map((slot) => {
      const value = storage[slot];
      if (value === undefined) throw new Error(`test getter: no slot ${slot}`);
      return value;
    });
  };
  const get = (slots: readonly Hex.Hex[]) => read(slots);
  const getAsync = async (slots: readonly Hex.Hex[]) => {
    await Promise.resolve();
    return read(slots);
  };
  return { get, getAsync, calls };
}

const word = (value: bigint | Hex.Hex): Hex.Hex =>
  Hex.padLeft(typeof value === "bigint" ? Hex.fromNumber(value) : value, 32);

/** The preimage Solidity hashes for `mapping[key]`, with the mapping at `slot`. */
function mappingPreimage(key: Hex.Hex, slot: bigint | Hex.Hex): KeccakPreimage {
  const preimage = Hex.concat(word(key), word(slot));
  return { hash: Hash.keccak256(preimage), preimage };
}

// biome-ignore lint/suspicious/noExplicitAny: tests reach runtime-only behavior.
type Untyped = any;

// -----------------------------------------------------------------------------
// Reads

test("reads value types and returns the decoded values", () => {
  const { get } = getter({
    [word(0n)]: "0x2a",
    [word(1n)]: PACKED_OWNER_PAUSED,
    [word(2n)]: "0xffff",
    [word(3n)]: SALT,
  });
  const state = createStorageView(layout, get);

  expect(state.totalSupply).toBe(42n);
  expect(state.owner).toBe(OWNER);
  expect(state.paused).toBe(true);
  expect(state.debt).toBe(-1);
  expect(state.salt).toBe(SALT);
});

test("each leaf read requests only its own slot, with no cache", () => {
  const { get, calls } = getter({ [word(1n)]: PACKED_OWNER_PAUSED });
  const state = createStorageView(layout, get);

  expect(state.owner).toBe(OWNER);
  expect(state.paused).toBe(true);
  expect(state.owner).toBe(OWNER);
  expect(calls).toEqual([[word(1n)], [word(1n)], [word(1n)]]);
});

test("struct fields are read lazily, one field at a time", () => {
  const { get, calls } = getter({ [word(4n)]: METADATA_PACKED });
  const state = createStorageView(layout, get);
  const metadata = state.metadata;

  expect(calls).toEqual([]);
  expect(metadata.lastUpdate).toBe(42n);
  expect(metadata.active).toBe(true);
  expect(calls).toEqual([[word(4n)], [word(4n)]]);
});

test("reads nested structs, arrays of structs, and arrays of arrays", () => {
  const { get } = getter({
    [word(6n)]: "0x7b",
    [slotOf(complexLayout, "orders[1].amount")]: "0x9",
    [slotOf(complexLayout, "matrix[1][1]")]:
      `0x${"00".repeat(15)}2a${"00".repeat(16)}`,
  });

  expect(createStorageView(layout, get).metadata.inner.count).toBe(123n);
  const complex = createStorageView(complexLayout, get);
  expect(complex.orders[1].amount).toBe(9n);
  expect(complex.matrix[1][1]).toBe(42n);
});

test("reads packed fixed array elements", () => {
  const { get, calls } = getter({ [word(8n)]: PACKED_FIXED_NUMBERS });
  const state = createStorageView(layout, get);

  expect(state.fixedNumbers[0]).toBe(1n);
  expect(state.fixedNumbers[1]).toBe(2n);
  expect(calls).toEqual([[word(8n)], [word(8n)]]);
});

test("reads dynamic array elements from keccak256(slot)", () => {
  const { get, calls } = getter({
    [slotOf(layout, "dynamicNumbers[1]")]: "0x539",
  });
  const state = createStorageView(layout, get);

  expect(state.dynamicNumbers[1]).toBe(1337n);
  expect(calls).toEqual([[slotOf(layout, "dynamicNumbers[1]")]]);
});

test("length reads a dynamic array's slot; a fixed array's length needs no read", () => {
  const { get, calls } = getter({ [word(10n)]: "0x2" });
  const state = createStorageView(layout, get);

  expect(state.fixedNumbers.length).toBe(3);
  expect(calls).toEqual([]);
  expect(state.dynamicNumbers.length).toBe(2);
  expect(calls).toEqual([[word(10n)]]);
});

test("reads mapping values for any key form", () => {
  const checksummed = "0x1111111111111111111111111111111111111234";
  const { get } = getter({
    [slotOf(layout, `balances[${OWNER}]`)]: "0x64",
    [slotOf(layout, `allowances[${OWNER}][${SPENDER}]`)]: "0x2a",
  });
  const state = createStorageView(layout, get);

  expect(state.balances[OWNER]).toBe(100n);
  expect(
    state.balances[checksummed.toUpperCase().replace("0X", "0x") as Hex.Hex],
  ).toBe(100n);
  expect(state.allowances[OWNER]![SPENDER]).toBe(42n);
});

test("reads short bytes and strings in one call, long ones in two", () => {
  const long = `0x${"11".repeat(33)}` as Hex.Hex;
  const { get, calls } = getter({
    ...bytesStorage(slotOf(layout, "rawBytes"), long),
    ...bytesStorage(slotOf(layout, "message"), Hex.fromString("hello")),
  });
  const state = createStorageView(layout, get);

  expect(state.message).toBe("hello");
  expect(calls).toHaveLength(1);
  expect(state.rawBytes).toBe(long);
  // Root slot first, then its two data slots (33 bytes).
  expect(calls.slice(1).map((call) => call.length)).toEqual([1, 2]);
});

test("a corrupt bytes root word throws before any data slot read", () => {
  // `0xff…ff` decodes to a length of about 2^254 bytes.
  const { get, calls } = getter({
    [slotOf(layout, "message")]: `0x${"ff".repeat(32)}`,
  });

  expect(() => createStorageView(layout, get).message).toThrow(
    "is larger than the",
  );
  expect(calls).toHaveLength(1);
});

// -----------------------------------------------------------------------------
// Async reads

test("async: leaves and dynamic array length return promises", async () => {
  const { getAsync } = getter({ [word(0n)]: "0xff", [word(10n)]: "0x2" });
  const state = createStorageView(layout, getAsync);

  const supply = state.totalSupply;
  expect(supply).toBeInstanceOf(Promise);
  expect(await supply).toBe(255n);
  expect(await state.dynamicNumbers.length).toBe(2);
  expect(state.fixedNumbers.length).toBe(3);
});

test("async: composite access is synchronous; only the leaf read waits", async () => {
  const slot = slotOf(layout, `allowances[${OWNER}][${SPENDER}]`);
  const { getAsync, calls } = getter({ [slot]: "0x14" });
  const state = createStorageView(layout, getAsync);

  const inner = state.allowances[OWNER];
  expect(inner).not.toBeInstanceOf(Promise);
  expect(calls).toEqual([]);
  expect(await inner![SPENDER]).toBe(20n);
  expect(calls).toEqual([[slot]]);
});

test("async: long bytes take two sequential rounds", async () => {
  const long = `0x${"22".repeat(40)}` as Hex.Hex;
  const { getAsync, calls } = getter(
    bytesStorage(slotOf(layout, "rawBytes"), long),
  );

  expect(await createStorageView(layout, getAsync).rawBytes).toBe(long);
  expect(calls.map((call) => call.length)).toEqual([1, 2]);
});

test("async: a getter rejection rejects the read", async () => {
  const state = createStorageView(layout, async () => {
    throw new Error("rpc down");
  });

  await expect(state.totalSupply).rejects.toThrow("rpc down");
});

// -----------------------------------------------------------------------------
// Enumeration

test("Object.keys lists top-level variables, struct fields, and fixed array indexes", () => {
  const state = createStorageView(layout, getter({}).get);

  expect(Object.keys(state)).toEqual(layout.storage.map((item) => item.label));
  expect(Object.keys(state.metadata)).toEqual([
    "lastUpdate",
    "active",
    "admin",
    "inner",
  ]);
  expect(Object.keys(state.fixedNumbers)).toEqual(["0", "1", "2"]);
  expect(Reflect.ownKeys(state.metadata.inner)).toEqual(["count"]);
});

test("Object.keys lists the mapping keys found in the preimages", () => {
  const outer = mappingPreimage(OWNER, 13n);
  const state = createStorageView(layout, getter({}).get, [
    mappingPreimage(OWNER, 7n),
    mappingPreimage(SPENDER, 7n),
    mappingPreimage(OWNER, 7n), // duplicate
    outer, // allowances, another mapping
    mappingPreimage(SPENDER, outer.hash), // allowances[OWNER]
  ]);

  expect(Object.keys(state.balances)).toEqual([OWNER, SPENDER]);
  expect(Object.keys(state.allowances)).toEqual([OWNER]);
  expect(Object.keys(state.allowances[OWNER]!)).toEqual([SPENDER]);
  expect(Object.keys(state.allowances[SPENDER]!)).toEqual([]);
});

test("enumeration sees preimages appended after the proxy was created", () => {
  const preimages: KeccakPreimage[] = [];
  const balances = createStorageView(
    layout,
    getter({}).get,
    preimages,
  ).balances;

  expect(Object.keys(balances)).toEqual([]);
  expect(OWNER in balances).toBe(false);

  preimages.push(mappingPreimage(OWNER, 7n));

  expect(Object.keys(balances)).toEqual([OWNER]);
  expect(OWNER in balances).toBe(true);
});

test("enumeration rebuilds its key index when the preimage array shrinks", () => {
  const preimages: KeccakPreimage[] = [
    mappingPreimage(OWNER, 7n),
    mappingPreimage(SPENDER, 7n),
  ];
  const balances = createStorageView(
    layout,
    getter({}).get,
    preimages,
  ).balances;

  expect(Object.keys(balances)).toEqual([OWNER, SPENDER]);

  preimages.length = 0;
  preimages.push(mappingPreimage(SPENDER, 7n));

  expect(Object.keys(balances)).toEqual([SPENDER]);
  expect(OWNER in balances).toBe(false);
});

test("'in' and for...in follow the enumerable keys", () => {
  const state = createStorageView(layout, getter({}).get, [
    mappingPreimage(OWNER, 7n),
  ]);
  const keys: string[] = [];
  for (const key in state.balances) keys.push(key);

  expect("totalSupply" in state).toBe(true);
  expect("missing" in state).toBe(false);
  expect("lastUpdate" in state.metadata).toBe(true);
  expect("missing" in state.metadata).toBe(false);
  expect("2" in state.fixedNumbers).toBe(true);
  expect("3" in state.fixedNumbers).toBe(false);
  expect(keys).toEqual([OWNER]);
});

test("'in' is true only for known mapping keys", () => {
  const mixedCase = `0x${"AB".repeat(20)}` as Hex.Hex;
  const balances = createStorageView(layout, getter({}).get, [
    mappingPreimage(OWNER, 7n),
    mappingPreimage(mixedCase, 7n),
  ]).balances;

  expect(OWNER in balances).toBe(true);
  expect(Object.hasOwn(balances, OWNER)).toBe(true);
  expect(SPENDER in balances).toBe(false); // valid, but never hashed
  expect(Object.hasOwn(balances, SPENDER)).toBe(false);
  // Key text is matched by value, so hex case does not matter.
  expect(mixedCase.toLowerCase() in balances).toBe(true);
  expect(mixedCase in balances).toBe(true);
  expect("0x1234" in balances).toBe(false); // not 20 bytes
  expect("notHex" in balances).toBe(false);
});

test("Object.entries and spread read every enumerable leaf", async () => {
  const storage = {
    [word(4n)]: METADATA_PACKED,
    [word(5n)]: word(OWNER),
    [word(6n)]: "0x7",
  } as const;
  const sync = createStorageView(layout, getter(storage).get);

  expect(Object.fromEntries(Object.entries(sync.metadata.inner))).toEqual({
    count: 7n,
  });
  const { inner: _, ...fields } = { ...sync.metadata };
  expect(fields).toEqual({ lastUpdate: 42n, active: true, admin: OWNER });

  const async = createStorageView(layout, getter(storage).getAsync);
  const pending = { ...async.metadata.inner };
  expect(pending.count).toBeInstanceOf(Promise);
  expect(await pending.count).toBe(7n);
});

test("a dynamic array cannot be enumerated", () => {
  const state = createStorageView(layout, getter({}).get);

  expect(() => Object.keys(state.dynamicNumbers)).toThrow(
    "cannot enumerate dynamic array dynamicNumbers: read its length and index it instead",
  );
});

// -----------------------------------------------------------------------------
// console.log

test("console.log shows the selector and keys without reading storage", () => {
  const { get, calls } = getter({});
  const state = createStorageView(layout, get, [mappingPreimage(OWNER, 7n)]);

  expect(Bun.inspect(state)).toBe(
    `StorageView { ${layout.storage.map((item) => item.label).join(", ")} }`,
  );
  expect(Bun.inspect(state.metadata)).toBe(
    "StorageView metadata { lastUpdate, active, admin, inner }",
  );
  expect(Bun.inspect(state.balances)).toBe(`StorageView balances { ${OWNER} }`);
  expect(Bun.inspect(state.allowances)).toBe("StorageView allowances {}");
  expect(Bun.inspect(state.fixedNumbers)).toBe(
    "StorageView fixedNumbers { 0, 1, 2 }",
  );
  expect(Bun.inspect(state.dynamicNumbers)).toBe(
    "StorageView dynamicNumbers [dynamic array]",
  );
  expect(Bun.inspect({ metadata: state.metadata.inner })).toContain(
    "StorageView metadata.inner { count }",
  );
  expect(calls).toEqual([]);
});

// -----------------------------------------------------------------------------
// JS interop

test("symbols and reserved interop names return undefined", async () => {
  const { get } = getter({ [word(4n)]: METADATA_PACKED });
  const metadata: Untyped = createStorageView(layout, get).metadata;

  expect(metadata[Symbol.iterator]).toBeUndefined();
  expect(metadata[Symbol.toPrimitive]).toBeUndefined();
  for (const name of [
    "then",
    "catch",
    "finally",
    "toJSON",
    "asymmetricMatch",
  ]) {
    expect(metadata[name]).toBeUndefined();
  }
  // Not a thenable, so awaiting a nested proxy gives the proxy back.
  expect((await metadata).lastUpdate).toBe(42n);
});

test("state variables with reserved interop names are not reachable", () => {
  const reservedLayout = {
    storage: ["then", "toJSON"].map((label, index) => ({
      astId: index,
      contract: "src/Test.sol:Test" as const,
      label,
      offset: 0,
      slot: `${index}` as const,
      type: "t_uint256",
    })),
    types: {
      t_uint256: { encoding: "inplace", label: "uint256", numberOfBytes: "32" },
    },
  } satisfies StorageLayout;
  const state: Untyped = createStorageView(reservedLayout, getter({}).get);

  expect(state.then).toBeUndefined();
  expect(state.toJSON).toBeUndefined();
});

test("the view is read-only", () => {
  const state: Untyped = createStorageView(layout, getter({}).get);

  expect(() => {
    state.totalSupply = 1n;
  }).toThrow("storage view is read-only (attempted to change totalSupply)");
  expect(() => {
    delete state.metadata.active;
  }).toThrow("storage view is read-only (attempted to change active)");
  expect(() => Object.defineProperty(state, "owner", { value: 1 })).toThrow(
    "storage view is read-only (attempted to change owner)",
  );
});

// -----------------------------------------------------------------------------
// Errors

test("invalid property access throws with the selector", () => {
  const state: Untyped = createStorageView(layout, getter({}).get);

  expect(() => state.notAVariable).toThrow(
    "storage variable not found: notAVariable",
  );
  expect(() => state.metadata.notAField).toThrow(
    "struct field not found: metadata.notAField",
  );
  expect(() => state.fixedNumbers.notAnIndex).toThrow(
    "'notAnIndex' is not a valid subscript for fixedNumbers",
  );
  expect(() => state.fixedNumbers[3]).toThrow(
    "fixed array index out of bounds: fixedNumbers[3]",
  );
  expect(() => state.dynamicNumbers["1.5"]).toThrow(
    "'1.5' is not a valid subscript for dynamicNumbers",
  );
  expect(() => state.dynamicNumbers[-1]).toThrow(
    "dynamic array index out of bounds: dynamicNumbers[-1]",
  );
  expect(() => state.balances.notHex).toThrow(
    "'notHex' is not a valid subscript for balances",
  );
  expect(() => state.balances["0x1234"]).toThrow(
    "mapping key for 'balances' must be 20 bytes",
  );
});

test("getStorage must return one value per slot", () => {
  const empty = createStorageView(layout, (): Hex.Hex[] => []);
  const holes = createStorageView(
    layout,
    (slots) => slots.map(() => undefined) as unknown as Hex.Hex[],
  );

  expect(() => empty.totalSupply).toThrow(
    "getStorage returned 0 values for 1 slots",
  );
  expect(() => holes.totalSupply).toThrow(
    `getStorage returned no value for slot: ${word(0n)}`,
  );
});

test("getStorage receives canonical 32-byte slots", () => {
  const { get, calls } = getter({ [word(0n)]: "0x2a" });

  expect(createStorageView(layout, get).totalSupply).toBe(42n);
  expect(calls).toEqual([[word(0n)]]);
});

test("an unsupported value type throws on read", () => {
  const fixedLayout = {
    storage: [
      {
        astId: 1,
        contract: "src/Test.sol:Test",
        label: "rate",
        offset: 0,
        slot: "0",
        type: "t_fixed128x18",
      },
    ],
    types: {
      t_fixed128x18: {
        encoding: "inplace",
        label: "fixed128x18",
        numberOfBytes: "16",
      },
    },
  } as const satisfies StorageLayout;
  const state: Untyped = createStorageView(
    fixedLayout,
    getter({ [word(0n)]: "0x1" }).get,
  );

  expect(() => state.rate).toThrow(
    "unsupported storage path type 'fixed128x18' for rate",
  );
});
