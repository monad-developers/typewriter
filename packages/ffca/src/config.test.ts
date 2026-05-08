import { test } from "bun:test";
import { parseAbiParameters } from "abitype";
import {
  COUNTER_MUTATIONS,
  COUNTER_SIGNATURE_PARAMS,
  type CounterState,
  HARNESS_MUTATIONS,
  HARNESS_SCHEMA,
  HARNESS_SIGNATURE_PARAMS,
  type HarnessState,
  testMutationSchema,
} from "../test/utils";
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
        table: testMutationSchema,
        params: parseAbiParameters("address from, address to, uint256 amount"),
        apply: () => {},
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
        table: testMutationSchema,
        params: parseAbiParameters("uint256 size"),
        resolution: parseAbiParameters("(uint256 price, uint256 size)[] fills"),
        resolve: () => {},
        apply: () => {},
      },
    },
  });
});

// Counter keeps the config minimal: no user-owned persisted schema is needed
// for this type-level check.
test("createFFCA Counter (no schema)", () => {
  createFFCA({
    ...baseConfig,
    signature: { params: COUNTER_SIGNATURE_PARAMS },
    state: { initial: { total: 0n, nonce: 0n } as CounterState },
    mutations: COUNTER_MUTATIONS,
  });
});

// Harness has fan-out state (accounts, keys, nonces, balances). The schema
// module declared in test/utils.ts is app-owned; ffca only type-checks that it
// can be attached to config.
test("createFFCA Harness (with schema)", () => {
  createFFCA({
    ...baseConfig,
    signature: { params: HARNESS_SIGNATURE_PARAMS },
    state: {
      initial: { accounts: {}, balances: {} } as HarnessState,
      schema: HARNESS_SCHEMA,
    },
    mutations: HARNESS_MUTATIONS,
  });
});
