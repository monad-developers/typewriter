import { expect, test } from "bun:test";
import {
  layout,
  METADATA_PACKED,
  OWNER,
  PACKED_OWNER_PAUSED,
  SALT,
} from "../test/utils";
import {
  decodeStorage,
  encodeStorage,
  formatStoragePath,
  getStoragePath,
} from "./index";

test("getStoragePath maps changed slots to generated static paths", () => {
  expect(
    getStoragePath(layout, ["0x1"]).map(formatStoragePath),
  ).toMatchInlineSnapshot(`
      [
        "owner",
        "paused",
      ]
    `);
});

test("getStoragePath accepts explicit known paths", () => {
  expect(
    getStoragePath(layout, ["0x1"], { knownPaths: ["paused"] }).map(
      formatStoragePath,
    ),
  ).toMatchInlineSnapshot(`
    [
      "paused",
    ]
  `);
});

test("getStoragePath returns struct leaf paths", () => {
  expect(
    getStoragePath(layout, ["0x4"]).map(formatStoragePath),
  ).toMatchInlineSnapshot(`
      [
        "metadata.lastUpdate",
        "metadata.active",
      ]
    `);
});

test("decodeStorage decodes value types from raw slots", () => {
  const storage = {
    "0x0": "0x2a",
    "0x1": PACKED_OWNER_PAUSED,
    "0x2": "0xffff",
    "0x3": SALT,
    "0x4": METADATA_PACKED,
  } as const;

  expect(decodeStorage(layout, "totalSupply", storage)).toBe(42n);
  expect(decodeStorage(layout, "owner", storage)).toBe(OWNER);
  expect(decodeStorage(layout, "paused", storage)).toBe(true);
  expect(decodeStorage(layout, "debt", storage)).toBe(-1);
  expect(decodeStorage(layout, "salt", storage)).toBe(SALT);
  expect(decodeStorage(layout, "metadata.lastUpdate", storage)).toBe(42n);
  expect(decodeStorage(layout, "metadata.active", storage)).toBe(true);
  expect(() => decodeStorage(layout, "metadata", storage)).toThrow(
    "storage path does not point to a leaf value: metadata",
  );
});

test("encodeStorage encodes full-slot value types", () => {
  expect(encodeStorage(layout, "totalSupply", 42n)).toMatchInlineSnapshot(`
    [
      {
        "slot": "0x0000000000000000000000000000000000000000000000000000000000000000",
        "value": "0x000000000000000000000000000000000000000000000000000000000000002a",
      },
    ]
  `);
  expect(encodeStorage(layout, "salt", SALT)).toMatchInlineSnapshot(`
    [
      {
        "slot": "0x0000000000000000000000000000000000000000000000000000000000000003",
        "value": "0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
      },
    ]
  `);
});

test("encodeStorage preserves neighboring bytes for packed values", () => {
  const storage = {
    "0x1": PACKED_OWNER_PAUSED,
  } as const;

  expect(
    encodeStorage(layout, "paused", false, storage),
  ).toMatchInlineSnapshot(`
    [
      {
        "slot": "0x0000000000000000000000000000000000000000000000000000000000000001",
        "value": "0x0000000000000000000000001111111111111111111111111111111111111234",
      },
    ]
  `);
});

test("encodeStorage encodes nested struct fields", () => {
  const storage = {
    "0x4": METADATA_PACKED,
  } as const;

  expect(
    encodeStorage(layout, "metadata.active", false, storage),
  ).toMatchInlineSnapshot(`
    [
      {
        "slot": "0x0000000000000000000000000000000000000000000000000000000000000004",
        "value": "0x000000000000000000000000000000000000000000000000000000000000002a",
      },
    ]
  `);
  expect(() =>
    encodeStorage(
      layout,
      "metadata",
      {
        active: false,
        admin: OWNER,
        inner: { count: 100n },
        lastUpdate: 43n,
      },
      storage,
    ),
  ).toThrow("storage path does not point to a leaf value: metadata");
});

test("encodeStorage requires existing slots for packed values", () => {
  expect(() => encodeStorage(layout, "paused", false)).toThrow(
    "existing storage value is required to encode packed path: paused",
  );
});
