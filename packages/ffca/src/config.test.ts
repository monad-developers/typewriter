import { test } from "bun:test";
import { parseAbiParameters } from "abitype";
import type { FFCAConfig } from "./config";

// Stub mirroring `createFFCA`'s param signature. These tests only exercise
// the FFCAConfig type — calling the real runtime would boot anvil.
function createFFCA(_config: FFCAConfig): void {}

const baseConfig = {
  address: "0x0000000000000000000000000000000000000000",
  abi: [],
  // biome-ignore lint/suspicious/noExplicitAny: stub field, types not the focus
  account: {} as any,
  chainId: 1,
  rpcUrl: "http://localhost:8545",
  domain: { name: "", version: "1" },
  signature: {
    params: parseAbiParameters("uint8 keyType, bytes rawSignature"),
  },
} as const;

test("createFFCA state", () => {
  createFFCA({
    ...baseConfig,
    state: { initial: { counter: 0 } },
    mutations: {},
  });
});

test("createFFCA mutation", () => {
  createFFCA({
    ...baseConfig,
    state: { initial: {} as Record<string, { balance: bigint }> },
    mutations: {
      transfer: {
        tag: 0,
        params: parseAbiParameters("address from, address to, uint256 amount"),
        // FFCAMutationConfig's variants share field names; TS can't pick one
        // from the absence of `resolve` alone, so it widens these params to
        // `any` and noImplicitAny errors.
        // @ts-ignore
        apply: (_state, _args) => {},
      },
    },
  });
});

test("createFFCA mutation with resolution", () => {
  createFFCA({
    ...baseConfig,
    state: { initial: { bids: [] as { price: bigint; size: bigint }[] } },
    mutations: {
      marketOrder: {
        tag: 1,
        params: parseAbiParameters("uint256 size"),
        resolution: parseAbiParameters("(uint256 price, uint256 size)[] fills"),
        resolve: (_state, _args) => {},
        apply: (_state, _args, _resolution) => {},
      },
    },
  });
});
