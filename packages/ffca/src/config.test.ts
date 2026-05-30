import { test } from "bun:test";
import { parseAbiParameters } from "abitype";
import {
  COUNTER_MUTATIONS,
  COUNTER_SIGNATURE_PARAMS,
  EMPTY_STORAGE_LAYOUT,
  HARNESS_MUTATIONS,
} from "../test/utils";
import type { FFCAConfig } from "./config";

// Stub mirroring `createFFCA`'s param signature. These tests only exercise
// the FFCAConfig type — calling the real runtime would boot anvil.
function createFFCA(_config: FFCAConfig): void {}

const baseConfig = {
  address: "0x0000000000000000000000000000000000000000",
  signature: { params: COUNTER_SIGNATURE_PARAMS },
  // biome-ignore lint/suspicious/noExplicitAny: stub field, types not the focus
  account: {} as any,
  chainId: 1,
  rpcUrl: "http://localhost:8545",
  database: { url: "postgres://postgres@localhost:5432/postgres" },
  storageLayout: EMPTY_STORAGE_LAYOUT,
  domain: { name: "", version: "1" },
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
        params: parseAbiParameters("uint256 size"),
        resolution: parseAbiParameters("(uint256 price, uint256 size)[] fills"),
        resolve: () => {},
      },
    },
  });
});

test("createFFCA mutation with registered mapping keys", () => {
  createFFCA({
    ...baseConfig,
    mutations: {
      credit: {
        tag: 2,
        params: parseAbiParameters("bytes32 account, uint256 amount"),
        registerMappingKeys: ({ args }) => {
          const { account } = args as { account: string };
          return [`balances[${account}]`];
        },
      },
    },
  });
});

// Counter keeps the config minimal: no user-owned persisted schema is needed
// for this type-level check.
test("createFFCA Counter (no schema)", () => {
  createFFCA({
    ...baseConfig,
    confirmations: { safeBlockDepth: 2, finalizedBlockDepth: 8 },
    mutations: COUNTER_MUTATIONS,
  });
});

test("createFFCA Harness", () => {
  createFFCA({
    ...baseConfig,
    mutations: HARNESS_MUTATIONS,
  });
});
