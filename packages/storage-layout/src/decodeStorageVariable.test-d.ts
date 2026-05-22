import { expectTypeOf, test } from "bun:test";
import type { Hex } from "ox";
import { layout } from "../test/utils";
import type { StorageLayout, StorageVariableToPrimitiveType } from "./index";
import { decodeStorageVariable } from "./index";

test("decodeStorageVariable infers strict leaf return types", () => {
  const supply = decodeStorageVariable(layout, "totalSupply", {});
  const owner = decodeStorageVariable(layout, "owner", {});
  const nested = decodeStorageVariable(layout, "metadata.inner.count", {});
  const fixedArrayElement = decodeStorageVariable(
    layout,
    "fixedNumbers[1]",
    {},
  );
  const dynamicArrayElement = decodeStorageVariable(
    layout,
    "dynamicNumbers[1]",
    {},
  );
  const mappingValue = decodeStorageVariable(
    layout,
    `balances[${"0x123" as Hex.Hex}]`,
    {},
  );
  const rawBytes = decodeStorageVariable(layout, "rawBytes", {});
  const message = decodeStorageVariable(layout, "message", {});

  expectTypeOf(supply).toEqualTypeOf<
    StorageVariableToPrimitiveType<typeof layout, "totalSupply">
  >();
  expectTypeOf(owner).toEqualTypeOf<
    StorageVariableToPrimitiveType<typeof layout, "owner">
  >();
  expectTypeOf(nested).toEqualTypeOf<
    StorageVariableToPrimitiveType<typeof layout, "metadata.inner.count">
  >();
  expectTypeOf(fixedArrayElement).toEqualTypeOf<
    StorageVariableToPrimitiveType<typeof layout, "fixedNumbers[1]">
  >();
  expectTypeOf(dynamicArrayElement).toEqualTypeOf<
    StorageVariableToPrimitiveType<typeof layout, "dynamicNumbers[1]">
  >();
  expectTypeOf(mappingValue).toEqualTypeOf<
    StorageVariableToPrimitiveType<typeof layout, `balances[${Hex.Hex}]`>
  >();
  expectTypeOf(rawBytes).toEqualTypeOf<
    StorageVariableToPrimitiveType<typeof layout, "rawBytes">
  >();
  expectTypeOf(message).toEqualTypeOf<
    StorageVariableToPrimitiveType<typeof layout, "message">
  >();
});

test("decodeStorageVariable only accepts concrete leaf variables", () => {
  const typeAssertions = () => {
    decodeStorageVariable(layout, "totalSupply", {});
    decodeStorageVariable(layout, "metadata.lastUpdate", {});
    decodeStorageVariable(layout, "fixedNumbers[0]", {});
    decodeStorageVariable(layout, "dynamicNumbers[0]", {});
    decodeStorageVariable(layout, `balances[${"0x123" as Hex.Hex}]`, {});

    // @ts-expect-error structs are not concrete leaf paths
    decodeStorageVariable(layout, "metadata", {});
    // @ts-expect-error fixed array roots are not concrete leaf paths
    decodeStorageVariable(layout, "fixedNumbers", {});
    // @ts-expect-error dynamic array roots are not concrete leaf paths
    decodeStorageVariable(layout, "dynamicNumbers", {});
    // @ts-expect-error mappings require keys
    decodeStorageVariable(layout, "balances", {});
    // @ts-expect-error nested mappings require all keys to reach a leaf
    decodeStorageVariable(layout, `allowances[${"0x123" as Hex.Hex}]`, {});
    // @ts-expect-error fixed array index is out of bounds
    decodeStorageVariable(layout, "fixedNumbers[3]", {});
  };

  expectTypeOf(typeAssertions).toEqualTypeOf<() => void>();
});

test("decodeStorageVariable gracefully falls back for loose layouts", () => {
  const typeAssertions = () => {
    const looseLayout = {} as StorageLayout;
    const value = decodeStorageVariable(looseLayout, "anything", {});

    expectTypeOf(value).toEqualTypeOf<unknown>();
  };

  expectTypeOf(typeAssertions).toEqualTypeOf<() => void>();
});
