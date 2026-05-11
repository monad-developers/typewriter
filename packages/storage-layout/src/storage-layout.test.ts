import { expect, test } from "bun:test";
import { complexLayout, layout } from "../test/utils";
import {
  type ResolvedStorageItem,
  resolveStoragePath,
  storagePathEndsAtValue,
} from "./storage-layout";
import { formatStoragePath, parseStoragePath } from "./storage-path";

function summarizeResolvedStorageItem(resolved: ResolvedStorageItem) {
  return {
    baseSlot: resolved.baseSlot,
    item: {
      label: resolved.item.label,
      offset: resolved.item.offset,
      slot: resolved.item.slot,
      type: resolved.item.type,
    },
    path: formatStoragePath(resolved.path),
    type: resolved.type.label,
  };
}

test("resolveStoragePath resolves value paths", () => {
  expect(
    resolveStoragePath(layout, parseStoragePath("owner")).map(
      summarizeResolvedStorageItem,
    ),
  ).toMatchInlineSnapshot(`
    [
      {
        "baseSlot": 0n,
        "item": {
          "label": "owner",
          "offset": 0,
          "slot": "1",
          "type": "t_address",
        },
        "path": "owner",
        "type": "address",
      },
    ]
  `);
});

test("resolveStoragePath resolves nested struct paths", () => {
  expect(
    resolveStoragePath(layout, parseStoragePath("metadata.inner.count")).map(
      summarizeResolvedStorageItem,
    ),
  ).toMatchInlineSnapshot(`
    [
      {
        "baseSlot": 6n,
        "item": {
          "label": "count",
          "offset": 0,
          "slot": "0",
          "type": "t_uint256",
        },
        "path": "metadata.inner.count",
        "type": "uint256",
      },
    ]
  `);
});

test("resolveStoragePath expands whole structs", () => {
  expect(
    resolveStoragePath(layout, parseStoragePath("metadata")).map(
      summarizeResolvedStorageItem,
    ),
  ).toMatchInlineSnapshot(`
    [
      {
        "baseSlot": 4n,
        "item": {
          "label": "lastUpdate",
          "offset": 0,
          "slot": "0",
          "type": "t_uint64",
        },
        "path": "metadata.lastUpdate",
        "type": "uint64",
      },
      {
        "baseSlot": 4n,
        "item": {
          "label": "active",
          "offset": 8,
          "slot": "0",
          "type": "t_bool",
        },
        "path": "metadata.active",
        "type": "bool",
      },
      {
        "baseSlot": 4n,
        "item": {
          "label": "admin",
          "offset": 0,
          "slot": "1",
          "type": "t_address",
        },
        "path": "metadata.admin",
        "type": "address",
      },
      {
        "baseSlot": 6n,
        "item": {
          "label": "count",
          "offset": 0,
          "slot": "0",
          "type": "t_uint256",
        },
        "path": "metadata.inner.count",
        "type": "uint256",
      },
    ]
  `);
});

test("resolveStoragePath resolves fixed array elements", () => {
  expect(
    resolveStoragePath(layout, parseStoragePath("fixedNumbers[1]")).map(
      summarizeResolvedStorageItem,
    ),
  ).toMatchInlineSnapshot(`
    [
      {
        "baseSlot": 8n,
        "item": {
          "label": "fixedNumbers[1]",
          "offset": 16,
          "slot": "0",
          "type": "t_uint128",
        },
        "path": "fixedNumbers[1]",
        "type": "uint128",
      },
    ]
  `);
});

test("resolveStoragePath expands fixed arrays", () => {
  expect(
    resolveStoragePath(layout, parseStoragePath("fixedNumbers")).map(
      summarizeResolvedStorageItem,
    ),
  ).toMatchInlineSnapshot(`
    [
      {
        "baseSlot": 8n,
        "item": {
          "label": "fixedNumbers[0]",
          "offset": 0,
          "slot": "0",
          "type": "t_uint128",
        },
        "path": "fixedNumbers[0]",
        "type": "uint128",
      },
      {
        "baseSlot": 8n,
        "item": {
          "label": "fixedNumbers[1]",
          "offset": 16,
          "slot": "0",
          "type": "t_uint128",
        },
        "path": "fixedNumbers[1]",
        "type": "uint128",
      },
      {
        "baseSlot": 8n,
        "item": {
          "label": "fixedNumbers[2]",
          "offset": 0,
          "slot": "1",
          "type": "t_uint128",
        },
        "path": "fixedNumbers[2]",
        "type": "uint128",
      },
    ]
  `);
});

test("resolveStoragePath resolves dynamic arrays", () => {
  expect(
    resolveStoragePath(layout, parseStoragePath("dynamicNumbers")).map(
      summarizeResolvedStorageItem,
    ),
  ).toMatchInlineSnapshot(`
    [
      {
        "baseSlot": 0n,
        "item": {
          "label": "dynamicNumbers",
          "offset": 0,
          "slot": "10",
          "type": "t_array(t_uint256)dyn_storage",
        },
        "path": "dynamicNumbers",
        "type": "uint256[]",
      },
    ]
  `);
  expect(
    resolveStoragePath(layout, parseStoragePath("dynamicNumbers[1]")).map(
      summarizeResolvedStorageItem,
    ),
  ).toMatchInlineSnapshot(`
    [
      {
        "baseSlot": 89717814153306320011181716697424560163256864414616650038987186496166826726056n,
        "item": {
          "label": "dynamicNumbers[1]",
          "offset": 0,
          "slot": "1",
          "type": "t_uint256",
        },
        "path": "dynamicNumbers[1]",
        "type": "uint256",
      },
    ]
  `);
});

test("resolveStoragePath resolves arrays of structs", () => {
  expect(
    resolveStoragePath(complexLayout, parseStoragePath("orders[1].amount")).map(
      summarizeResolvedStorageItem,
    ),
  ).toMatchInlineSnapshot(`
    [
      {
        "baseSlot": 2n,
        "item": {
          "label": "amount",
          "offset": 0,
          "slot": "1",
          "type": "t_uint256",
        },
        "path": "orders[1].amount",
        "type": "uint256",
      },
    ]
  `);
});

test("resolveStoragePath resolves structs with array fields", () => {
  expect(
    resolveStoragePath(
      complexLayout,
      parseStoragePath("book.priceLevels[1]"),
    ).map(summarizeResolvedStorageItem),
  ).toMatchInlineSnapshot(`
    [
      {
        "baseSlot": 10n,
        "item": {
          "label": "priceLevels[1]",
          "offset": 16,
          "slot": "0",
          "type": "t_uint128",
        },
        "path": "book.priceLevels[1]",
        "type": "uint128",
      },
    ]
  `);
  expect(
    resolveStoragePath(complexLayout, parseStoragePath("book")).map(
      summarizeResolvedStorageItem,
    ),
  ).toMatchInlineSnapshot(`
    [
      {
        "baseSlot": 10n,
        "item": {
          "label": "priceLevels[0]",
          "offset": 0,
          "slot": "0",
          "type": "t_uint128",
        },
        "path": "book.priceLevels[0]",
        "type": "uint128",
      },
      {
        "baseSlot": 10n,
        "item": {
          "label": "priceLevels[1]",
          "offset": 16,
          "slot": "0",
          "type": "t_uint128",
        },
        "path": "book.priceLevels[1]",
        "type": "uint128",
      },
      {
        "baseSlot": 11n,
        "item": {
          "label": "count",
          "offset": 0,
          "slot": "0",
          "type": "t_uint256",
        },
        "path": "book.inner.count",
        "type": "uint256",
      },
    ]
  `);
});

test("resolveStoragePath resolves arrays of arrays", () => {
  expect(
    resolveStoragePath(complexLayout, parseStoragePath("matrix[1][0]")).map(
      summarizeResolvedStorageItem,
    ),
  ).toMatchInlineSnapshot(`
    [
      {
        "baseSlot": 21n,
        "item": {
          "label": "matrix[1][0]",
          "offset": 0,
          "slot": "0",
          "type": "t_uint128",
        },
        "path": "matrix[1][0]",
        "type": "uint128",
      },
    ]
  `);
  expect(
    resolveStoragePath(complexLayout, parseStoragePath("matrix")).map(
      summarizeResolvedStorageItem,
    ),
  ).toMatchInlineSnapshot(`
    [
      {
        "baseSlot": 20n,
        "item": {
          "label": "matrix[0][0]",
          "offset": 0,
          "slot": "0",
          "type": "t_uint128",
        },
        "path": "matrix[0][0]",
        "type": "uint128",
      },
      {
        "baseSlot": 20n,
        "item": {
          "label": "matrix[0][1]",
          "offset": 16,
          "slot": "0",
          "type": "t_uint128",
        },
        "path": "matrix[0][1]",
        "type": "uint128",
      },
      {
        "baseSlot": 21n,
        "item": {
          "label": "matrix[1][0]",
          "offset": 0,
          "slot": "0",
          "type": "t_uint128",
        },
        "path": "matrix[1][0]",
        "type": "uint128",
      },
      {
        "baseSlot": 21n,
        "item": {
          "label": "matrix[1][1]",
          "offset": 16,
          "slot": "0",
          "type": "t_uint128",
        },
        "path": "matrix[1][1]",
        "type": "uint128",
      },
    ]
  `);
});

test("resolveStoragePath rejects unsupported paths", () => {
  expect(() =>
    resolveStoragePath(layout, parseStoragePath("balances")),
  ).toThrow(
    "unsupported storage path type 'mapping(address => uint256)' for balances",
  );
  expect(() =>
    resolveStoragePath(layout, parseStoragePath("balances[0x1234]")),
  ).toThrow("subscript storage paths are not supported yet: balances[0x1234]");
  expect(() =>
    resolveStoragePath(layout, parseStoragePath("fixedNumbers[3]")),
  ).toThrow("fixed array index out of bounds: fixedNumbers[3]");
});

test("isStoragePathEnd identifies terminal paths", () => {
  expect(storagePathEndsAtValue(layout, parseStoragePath("totalSupply"))).toBe(
    true,
  );
  expect(storagePathEndsAtValue(layout, parseStoragePath("metadata"))).toBe(
    false,
  );
  expect(
    storagePathEndsAtValue(layout, parseStoragePath("metadata.lastUpdate")),
  ).toBe(true);
  expect(
    storagePathEndsAtValue(layout, parseStoragePath("metadata.inner")),
  ).toBe(false);
  expect(storagePathEndsAtValue(layout, parseStoragePath("fixedNumbers"))).toBe(
    false,
  );
  expect(
    storagePathEndsAtValue(layout, parseStoragePath("fixedNumbers[0]")),
  ).toBe(true);
  expect(
    storagePathEndsAtValue(layout, parseStoragePath("dynamicNumbers")),
  ).toBe(false);
  expect(
    storagePathEndsAtValue(layout, parseStoragePath("dynamicNumbers[0]")),
  ).toBe(true);
  expect(() =>
    storagePathEndsAtValue(layout, parseStoragePath("balances")),
  ).toThrow(
    "unsupported storage path type 'mapping(address => uint256)' for balances",
  );
});
