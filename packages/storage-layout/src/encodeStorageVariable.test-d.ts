import { expectTypeOf, test } from "bun:test";
import type { Hex } from "ox";
import { layout } from "../test/utils";
import type { SlotWrites, StorageLayout } from "./index";
import { encodeStorageVariable } from "./index";

test("encodeStorageVariable infers strict leaf value types", () => {
  const supplyWrites = encodeStorageVariable(layout, "totalSupply", 1n);
  const ownerWrites = encodeStorageVariable(
    layout,
    "owner",
    "0x123" as Hex.Hex,
  );
  const nestedWrites = encodeStorageVariable(
    layout,
    "metadata.inner.count",
    1n,
  );
  const fixedArrayElementWrites = encodeStorageVariable(
    layout,
    "fixedNumbers[1]",
    1n,
  );
  const dynamicArrayElementWrites = encodeStorageVariable(
    layout,
    "dynamicNumbers[1]",
    1n,
  );
  const mappingWrites = encodeStorageVariable(
    layout,
    `balances[${"0x123" as Hex.Hex}]`,
    1n,
  );
  const bytesWrites = encodeStorageVariable(layout, "rawBytes", "0x1234");
  const stringWrites = encodeStorageVariable(layout, "message", "hello");

  expectTypeOf(supplyWrites).toEqualTypeOf<SlotWrites>();
  expectTypeOf(ownerWrites).toEqualTypeOf<SlotWrites>();
  expectTypeOf(nestedWrites).toEqualTypeOf<SlotWrites>();
  expectTypeOf(fixedArrayElementWrites).toEqualTypeOf<SlotWrites>();
  expectTypeOf(dynamicArrayElementWrites).toEqualTypeOf<SlotWrites>();
  expectTypeOf(mappingWrites).toEqualTypeOf<SlotWrites>();
  expectTypeOf(bytesWrites).toEqualTypeOf<SlotWrites>();
  expectTypeOf(stringWrites).toEqualTypeOf<SlotWrites>();
});

test("encodeStorageVariable rejects wrong leaf value types", () => {
  const typeAssertions = () => {
    // @ts-expect-error uint256 values are bigints
    encodeStorageVariable(layout, "totalSupply", 1);
    // @ts-expect-error bool values are booleans
    encodeStorageVariable(layout, "paused", 1n);
    // @ts-expect-error bytes values are hex strings
    encodeStorageVariable(layout, "rawBytes", 1n);
    // @ts-expect-error string values are strings
    encodeStorageVariable(layout, "message", 1n);
  };

  expectTypeOf(typeAssertions).toEqualTypeOf<() => void>();
});

test("encodeStorageVariable only accepts concrete leaf variables", () => {
  const typeAssertions = () => {
    encodeStorageVariable(layout, "totalSupply", 1n);
    encodeStorageVariable(layout, "metadata.lastUpdate", 1n);
    encodeStorageVariable(layout, "fixedNumbers[0]", 1n);
    encodeStorageVariable(layout, "dynamicNumbers[0]", 1n);
    encodeStorageVariable(layout, `balances[${"0x123" as Hex.Hex}]`, 1n);

    // @ts-expect-error structs are not concrete leaf paths
    encodeStorageVariable(layout, "metadata", {});
    // @ts-expect-error fixed array roots are not concrete leaf paths
    encodeStorageVariable(layout, "fixedNumbers", [1n, 2n, 3n]);
    // @ts-expect-error dynamic array roots are not concrete leaf paths
    encodeStorageVariable(layout, "dynamicNumbers", [1n]);
    // @ts-expect-error mappings require keys
    encodeStorageVariable(layout, "balances", {});
    // @ts-expect-error nested mappings require all keys to reach a leaf
    encodeStorageVariable(layout, `allowances[${"0x123" as Hex.Hex}]`, {});
    // @ts-expect-error fixed array index is out of bounds
    encodeStorageVariable(layout, "fixedNumbers[3]", 1n);
  };

  expectTypeOf(typeAssertions).toEqualTypeOf<() => void>();
});

test("encodeStorageVariable gracefully falls back for loose layouts", () => {
  const typeAssertions = () => {
    const looseLayout = {} as StorageLayout;
    const writes = encodeStorageVariable(
      looseLayout,
      "anything",
      {} as unknown,
    );

    expectTypeOf(writes).toEqualTypeOf<SlotWrites>();
  };

  expectTypeOf(typeAssertions).toEqualTypeOf<() => void>();
});
