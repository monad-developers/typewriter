import { expect, test } from "bun:test";
import { expectSingleSlot, layout, OWNER } from "../test/utils";
import {
  getStorageSlot,
  getStorageVariable,
  type StorageLayout,
} from "./index";

const reversibleLayout = {
  ...layout,
  storage: layout.storage.filter(
    (item) => layout.types[item.type]?.encoding !== "mapping",
  ),
} satisfies StorageLayout;

test("getStorageVariable returns no matches for untouched slots", () => {
  expect(getStorageVariable(reversibleLayout, "0x123")).toEqual([]);
});

test("getStorageVariable returns multiple variables for packed slots", () => {
  expect(getStorageVariable(layout, "0x1")).toEqual(["owner", "paused"]);
});

test("getStorageVariable returns multiple struct packed fields", () => {
  expect(getStorageVariable(reversibleLayout, "0x4")).toEqual([
    "metadata.lastUpdate",
    "metadata.active",
  ]);
});

test("getStorageVariable returns multiple fixed array packed values", () => {
  expect(getStorageVariable(reversibleLayout, "0x8")).toEqual([
    "fixedNumbers[0]",
    "fixedNumbers[1]",
  ]);
});

test("getStorageVariable expands reversible composite known variables", () => {
  expect(getStorageVariable(layout, "0x4", ["metadata"])).toEqual([
    "metadata.lastUpdate",
    "metadata.active",
  ]);
});

test("getStorageVariable rejects mapping slots without known variables", () => {
  const balanceSlot = expectSingleSlot(
    getStorageSlot(layout, `balances[${OWNER}]`),
  );

  expect(() => getStorageVariable(layout, balanceSlot)).toThrow(
    "cannot infer storage variable for mapping 'balances' from raw slot: Solidity hashes mapping keys into slot addresses, so mapping slots are not reversible from a slot alone; pass knownVariables to match keyed mappings",
  );
});

test("getStorageVariable returns keyed mapping variables from knownVariables", () => {
  const balanceSlot = expectSingleSlot(
    getStorageSlot(layout, `balances[${OWNER}]`),
  );

  expect(
    getStorageVariable(layout, balanceSlot, ["owner", `balances[${OWNER}]`]),
  ).toEqual([`balances[${OWNER}]`]);
});

test("getStorageVariable returns no matches for unknown slots with knownVariables", () => {
  expect(
    getStorageVariable(layout, "0xff", ["owner", `balances[${OWNER}]`]),
  ).toEqual([]);
});

test("getStorageVariable de-dupes duplicate matches in stable order", () => {
  expect(
    getStorageVariable(layout, "0x4", [
      "metadata",
      "metadata.lastUpdate",
      "metadata.active",
      "metadata",
    ]),
  ).toEqual(["metadata.lastUpdate", "metadata.active"]);
});

test("getStorageVariable fails loudly for invalid knownVariables", () => {
  expect(() =>
    getStorageVariable(layout as StorageLayout, "0x1", ["missing"]),
  ).toThrow("storage variable not found: missing");
});

test("getStorageVariable supports loose StorageLayout inputs", () => {
  const looseLayout: StorageLayout = layout;

  expect(getStorageVariable(looseLayout, "0x1", ["owner"])).toEqual([
    "owner",
    "paused",
  ]);
});
