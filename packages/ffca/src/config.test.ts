import { test } from "bun:test";
import { parseAbiParameters } from "abitype";
import {
  COUNTER_MUTATIONS,
  COUNTER_SIGNATURE_PARAMS,
  EMPTY_STORAGE_LAYOUT,
  HARNESS_MUTATIONS,
  HARNESS_SCHEMA,
  HARNESS_SIGNATURE_PARAMS,
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
  database: { url: "postgres://postgres@localhost:5432/postgres" },
  storageLayout: EMPTY_STORAGE_LAYOUT,
  domain: { name: "", version: "1" },
  signature: {
    params: parseAbiParameters("uint8 keyType, bytes rawSignature"),
  },
} as const;

test("createFFCA state", () => {
  createFFCA({
    ...baseConfig,
    mutations: {},
  });
});

test("createFFCA mutation", () => {
  createFFCA({
    ...baseConfig,
    mutations: {
      transfer: {
        tag: 0,
        table: testMutationSchema,
        params: parseAbiParameters("address from, address to, uint256 amount"),
      },
    },
  });
});

test("createFFCA mutation with resolution", () => {
  createFFCA({
    ...baseConfig,
    mutations: {
      marketOrder: {
        tag: 1,
        table: testMutationSchema,
        params: parseAbiParameters("uint256 size"),
        resolution: parseAbiParameters("(uint256 price, uint256 size)[] fills"),
        resolve: () => {},
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
    confirmations: { safeBlockDepth: 2, finalizedBlockDepth: 8 },
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
      schema: HARNESS_SCHEMA,
    },
    mutations: HARNESS_MUTATIONS,
  });
});
