import { expectTypeOf, test } from "bun:test";
import type { Hex } from "ox";
import { layout } from "../test/utils";
import { createStorageProxy, type StorageLayout } from "./index";

type TestSlotMap = { [slot: Hex.Hex]: Hex.Hex };

test("createStorageProxy follows sync and async getter shapes", () => {
  const syncGetter = (_slots: Hex.Hex[]): TestSlotMap => ({});
  const asyncGetter = async (_slots: Hex.Hex[]): Promise<TestSlotMap> => ({});
  const syncState = createStorageProxy(layout, syncGetter);
  const asyncState = createStorageProxy(layout, asyncGetter);

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

test("createStorageProxy gracefully falls back for loose layouts", () => {
  const syncGetter = (_slots: Hex.Hex[]): TestSlotMap => ({});
  const looseState = createStorageProxy({} as StorageLayout, syncGetter);

  expectTypeOf(looseState).toEqualTypeOf<Readonly<Record<string, unknown>>>();
});
