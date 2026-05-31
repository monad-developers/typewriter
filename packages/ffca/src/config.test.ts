import { expectTypeOf, test } from "bun:test";
import { parseAbiParameters } from "abitype";
import type { StorageProxy } from "storage-layout";
import type { Address, Hex } from "viem";
import {
  COUNTER_MUTATIONS,
  COUNTER_SIGNATURE_PARAMS,
  COUNTER_STORAGE_LAYOUT,
  EMPTY_STORAGE_LAYOUT,
  HARNESS_MUTATIONS,
  HARNESS_STORAGE_LAYOUT,
} from "../test/utils";
import type { FFCAConfig } from "./config";
import { createFFCA } from "./index";

// Stub mirroring `createFFCA`'s param signature. These tests only exercise
// the FFCAConfig type — calling the real runtime would boot anvil.
function createFFCAStub(_config: FFCAConfig): void {}

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

test("createFFCAStub state", () => {
  createFFCAStub({
    ...baseConfig,
    mutations: {},
  });
});

test("createFFCAStub mutation", () => {
  createFFCAStub({
    ...baseConfig,
    mutations: {
      transfer: {
        tag: 0,
        params: parseAbiParameters("address from, address to, uint256 amount"),
      },
    },
  });
});

test("createFFCAStub mutation with resolution", () => {
  createFFCAStub({
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

test("createFFCAStub mutation with registered mapping keys", () => {
  createFFCAStub({
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
test("createFFCAStub Counter (no schema)", () => {
  createFFCAStub({
    ...baseConfig,
    confirmations: { safeBlockDepth: 2, finalizedBlockDepth: 8 },
    mutations: COUNTER_MUTATIONS,
  });
});

test("createFFCAStub Harness", () => {
  createFFCAStub({
    ...baseConfig,
    mutations: HARNESS_MUTATIONS,
  });
});

// ---------------------------------------------------------------------------
// Type-level inference tests
//
// These assert the generic inference behavior we want from createFFCA.
// They call the real createFFCA so that the type assertions exercise the
// actual exported types. Until FFCAConfig, createFFCA, and FFCA are made
// generic over M / S / L, these assertions are expected to fail type-check.
// ---------------------------------------------------------------------------

test("state is typed from storageLayout", async () => {
  const app = await createFFCA({
    ...baseConfig,
    storageLayout: COUNTER_STORAGE_LAYOUT,
    mutations: {},
  });

  expectTypeOf(app.state).toEqualTypeOf<
    StorageProxy<typeof COUNTER_STORAGE_LAYOUT, true>
  >();
});

test("execute input is a discriminated union typed from mutations and signature", async () => {
  const app = await createFFCA({
    ...baseConfig,
    signature: {
      params: parseAbiParameters("uint8 keyType, bytes rawSignature"),
    },
    mutations: {
      transfer: {
        tag: 0,
        params: parseAbiParameters("address from, address to, uint256 amount"),
      },
      mint: {
        tag: 1,
        params: parseAbiParameters("address to, uint256 amount"),
      },
    },
  });

  type Input = Parameters<typeof app.execute>[0];

  expectTypeOf<Input>().toEqualTypeOf<
    | {
        name: "transfer";
        args: [Address, Address, bigint];
        signature: [number, Hex];
      }
    | { name: "mint"; args: [Address, bigint]; signature: [number, Hex] }
  >();
});

test("execute output includes resolution when mutation defines it", async () => {
  const app = await createFFCA({
    ...baseConfig,
    mutations: {
      marketOrder: {
        tag: 0,
        params: parseAbiParameters("uint256 size"),
        resolution: parseAbiParameters("(uint256 price, uint256 size)[] fills"),
        resolve: () => [],
      },
    },
  });

  type Result = Awaited<ReturnType<typeof app.execute>>;

  expectTypeOf<Result>().toEqualTypeOf<{
    name: "marketOrder";
    id: number;
    resolution: [{ price: bigint; size: bigint }][];
  }>();
});

test("execute output omits resolution when mutation has none", async () => {
  const app = await createFFCA({
    ...baseConfig,
    mutations: {
      transfer: {
        tag: 0,
        params: parseAbiParameters("address from, address to, uint256 amount"),
      },
    },
  });

  type Result = Awaited<ReturnType<typeof app.execute>>;

  expectTypeOf<Result>().toEqualTypeOf<{ name: "transfer"; id: number }>();
});

test("resolve receives typed state, args, and signature", async () => {
  await createFFCA({
    ...baseConfig,
    storageLayout: HARNESS_STORAGE_LAYOUT,
    signature: {
      params: parseAbiParameters(
        "bytes32 account, uint64 keyId, uint8 keyType, bytes rawSignature",
      ),
    },
    mutations: {
      debit: {
        tag: 0,
        params: parseAbiParameters(
          "bytes32 account, uint64 keyId, uint256 amount, uint256 nonce",
        ),
        resolution: parseAbiParameters("uint256 newBalance"),
        resolve: ({ state, args, signature }) => {
          expectTypeOf(state).toEqualTypeOf<
            StorageProxy<typeof HARNESS_STORAGE_LAYOUT, true>
          >();
          expectTypeOf(args).toEqualTypeOf<[Hex, bigint, bigint, bigint]>();
          expectTypeOf(signature).toEqualTypeOf<[Hex, bigint, number, Hex]>();
          return { newBalance: 0n };
        },
      },
    },
  });
});

test("registerMappingKeys receives typed args, signature, and optional resolution", async () => {
  await createFFCA({
    ...baseConfig,
    signature: {
      params: parseAbiParameters(
        "bytes32 account, uint64 keyId, uint8 keyType, bytes rawSignature",
      ),
    },
    mutations: {
      credit: {
        tag: 0,
        params: parseAbiParameters("bytes32 account, uint256 amount"),
        resolution: parseAbiParameters("uint256 newBalance"),
        registerMappingKeys: ({ params, signature, resolution }) => {
          expectTypeOf(params).toEqualTypeOf<[Hex, bigint]>();
          expectTypeOf(signature).toEqualTypeOf<[Hex, bigint, number, Hex]>();
          expectTypeOf(resolution).toEqualTypeOf<{ newBalance: bigint }>();
          return [];
        },
      },
    },
  });
});

test("on('mutation') event args are typed per mutation name", async () => {
  const app = await createFFCA({
    ...baseConfig,
    mutations: {
      transfer: {
        tag: 0,
        params: parseAbiParameters("address from, address to, uint256 amount"),
      },
    },
  });

  app.on("mutation", (event) => {
    if (event.name === "transfer") {
      expectTypeOf(event.args).toEqualTypeOf<[Address, Address, bigint]>();
      expectTypeOf(event.signature).toEqualTypeOf<[Hex, Hex, Hex]>();
    }
  });
});
