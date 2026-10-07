import { expectTypeOf, test } from "bun:test";
import type { Hex } from "ox";
import { layout } from "../test/utils";
import { createStorageView, type StorageLayout } from "./index";

test("createStorageView follows sync and async getter shapes", () => {
  const syncGetter = (_slots: readonly Hex.Hex[]): Hex.Hex[] => [];
  const asyncGetter = async (
    _slots: readonly Hex.Hex[],
  ): Promise<Hex.Hex[]> => [];
  const syncState = createStorageView(layout, syncGetter);
  const asyncState = createStorageView(layout, asyncGetter);

  expectTypeOf(syncState.totalSupply).toEqualTypeOf<bigint>();
  expectTypeOf(syncState.metadata).toEqualTypeOf<{
    readonly lastUpdate: bigint;
    readonly active: boolean;
    readonly admin: `0x${string}`;
    readonly inner: { readonly count: bigint };
  }>();
  expectTypeOf(syncState.balances).toEqualTypeOf<{
    readonly [K: Hex.Hex]: bigint;
  }>();
  expectTypeOf(syncState.allowances).toEqualTypeOf<{
    readonly [K: Hex.Hex]: { readonly [K: Hex.Hex]: bigint };
  }>();
  expectTypeOf(syncState.fixedNumbers).toEqualTypeOf<
    readonly [bigint, bigint, bigint]
  >();
  expectTypeOf(syncState.dynamicNumbers).toEqualTypeOf<{
    readonly [index: number]: bigint;
    readonly length: number;
  }>();

  expectTypeOf(asyncState.totalSupply).toEqualTypeOf<Promise<bigint>>();
  expectTypeOf(asyncState.metadata).toEqualTypeOf<{
    readonly lastUpdate: Promise<bigint>;
    readonly active: Promise<boolean>;
    readonly admin: Promise<`0x${string}`>;
    readonly inner: { readonly count: Promise<bigint> };
  }>();
  expectTypeOf(asyncState.balances).toEqualTypeOf<{
    readonly [K: Hex.Hex]: Promise<bigint>;
  }>();
  expectTypeOf(asyncState.allowances).toEqualTypeOf<{
    readonly [K: Hex.Hex]: { readonly [K: Hex.Hex]: Promise<bigint> };
  }>();
  expectTypeOf(asyncState.fixedNumbers).toEqualTypeOf<
    readonly [Promise<bigint>, Promise<bigint>, Promise<bigint>]
  >();
  expectTypeOf<(typeof asyncState.fixedNumbers)["length"]>().toEqualTypeOf<3>();
  expectTypeOf(asyncState.dynamicNumbers).toEqualTypeOf<{
    readonly [index: number]: Promise<bigint>;
    readonly length: Promise<number>;
  }>();
});

test("createStorageView gracefully falls back for loose layouts", () => {
  const syncGetter = (_slots: readonly Hex.Hex[]): Hex.Hex[] => [];
  const asyncGetter = async (
    _slots: readonly Hex.Hex[],
  ): Promise<Hex.Hex[]> => [];
  const looseState = createStorageView({} as StorageLayout, syncGetter);
  const looseAsyncState = createStorageView({} as StorageLayout, asyncGetter);
  const accountsKey = "accounts";
  const balanceKey = "balance";

  expectTypeOf(looseState[accountsKey]).toBeAny();
  expectTypeOf(looseAsyncState[accountsKey]).toBeAny();
  expectTypeOf(looseAsyncState[accountsKey]["0xabcd"][balanceKey]).toBeAny();
});

test("createStorageView takes a set of keccak preimages", () => {
  const syncGetter = (_slots: readonly Hex.Hex[]): Hex.Hex[] => [];
  const typeAssertions = () => {
    createStorageView(layout, syncGetter, new Set(["0x2" as const]));
    // @ts-expect-error an array of preimages is no longer accepted
    createStorageView(layout, syncGetter, [{ hash: "0x1", preimage: "0x2" }]);
  };
  expectTypeOf(typeAssertions).toEqualTypeOf<() => void>();
});

test("createStorageView takes an ordered-array getter", () => {
  const typeAssertions = () => {
    createStorageView(layout, (slots) => slots.map(() => "0x0" as const));
    // @ts-expect-error a slot-keyed object is no longer accepted
    createStorageView(layout, (_slots: readonly Hex.Hex[]) => ({}));
  };
  expectTypeOf(typeAssertions).toEqualTypeOf<() => void>();
});
