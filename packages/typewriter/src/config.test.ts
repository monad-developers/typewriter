import { expect, expectTypeOf, test } from "bun:test";
import type { Hex } from "ox";
import type { StorageView } from "storage-layout";
import {
  createTypewriterApp,
  type DevChain,
  type MutationsConfig,
  type SequencingConfig,
  type StorageConfig,
  type TypewriterConfig,
  validateConfig,
} from "./config";
import type {
  Authorization,
  Typewriter,
  TypewriterMutationInput,
} from "./index";
import { BUILTIN_MUTATIONS } from "./typewriter-constants";

const STORAGE_LAYOUT = {
  storage: [
    {
      astId: 1,
      contract: "Test.sol:Test",
      label: "accounts",
      offset: 0,
      slot: "0",
      type: "accounts",
    },
    {
      astId: 2,
      contract: "Test.sol:Test",
      label: "state",
      offset: 0,
      slot: "1",
      type: "state",
    },
  ],
  types: {
    accounts: {
      encoding: "mapping",
      label: "mapping(bytes32 => uint256)",
      numberOfBytes: "32",
      key: "bytes32",
      value: "uint256",
    },
    bytes32: {
      encoding: "inplace",
      label: "bytes32",
      numberOfBytes: "32",
    },
    state: {
      encoding: "inplace",
      label: "struct State",
      numberOfBytes: "32",
      members: [
        {
          astId: 3,
          contract: "Test.sol:Test",
          label: "totalSupply",
          offset: 0,
          slot: "0",
          type: "uint256",
        },
      ],
    },
    uint256: {
      encoding: "inplace",
      label: "uint256",
      numberOfBytes: "32",
    },
  },
} as const satisfies StorageConfig;

const MUTATIONS = {
  Ping: {
    id: 0,
    params: [{ name: "amount", type: "uint256" }],
  },
  ...BUILTIN_MUTATIONS,
} as const;

const AUTHORIZATION = {
  accountID: "0x01",
  credentialID: 0n,
  nonce: 0n,
  expiration: 0n,
  signature: "0x02",
} as const satisfies Authorization;

function createTypewriterTest<
  storageConfig extends StorageConfig = StorageConfig,
  mutationsConfig extends MutationsConfig = MutationsConfig,
  sequencingConfig extends SequencingConfig = SequencingConfig,
>(): Typewriter<storageConfig, mutationsConfig, sequencingConfig> {
  return {} as Typewriter<storageConfig, mutationsConfig, sequencingConfig>;
}

const publicConfig = {
  address: "0x0000000000000000000000000000000000000000",
  account: {} as TypewriterConfig["account"],
  chainId: 1,
  rpcUrl: "http://localhost:8545",
  database: { url: "postgres://postgres@localhost:5432/postgres" },
} as const satisfies TypewriterConfig;

test("createTypewriterApp constructs a serializable manifest", () => {
  const app = createTypewriterApp({
    config: publicConfig,
    abi: [],
    storageLayout: STORAGE_LAYOUT,
    mutations: MUTATIONS,
  });

  expect(app.manifest).toEqual({
    chainId: 1,
    address: publicConfig.address,
    mutations: MUTATIONS,
  });
});

test("validateConfig lists every missing network field outside dev", () => {
  expect(() => validateConfig({ database: publicConfig.database })).toThrow(
    "config.address, config.account, config.chainId, config.rpcUrl are required unless config.dev is set",
  );
});

test("validateConfig rejects network fields in dev", () => {
  expect(() =>
    validateConfig({
      dev: true,
      address: publicConfig.address,
      rpcUrl: publicConfig.rpcUrl,
      database: publicConfig.database,
    }),
  ).toThrow(
    "config.dev starts its own Anvil, so leave config.address, config.rpcUrl unset",
  );
});

test("createTypewriterApp takes the network from the dev chain", () => {
  const devChain: DevChain = {
    address: "0x5FbDB2315678afecb367f032d93F642f64180aa3",
    account: {} as DevChain["account"],
    chainId: 31337,
    hardfork: "MonadTen",
    rpcUrl: "http://127.0.0.1:8545",
  };
  const app = createTypewriterApp({
    config: { dev: true, database: publicConfig.database },
    abi: [],
    storageLayout: STORAGE_LAYOUT,
    mutations: MUTATIONS,
    devChain,
  });

  expect(app).toMatchObject({
    dev: true,
    address: devChain.address,
    chainId: 31337,
    hardfork: "MonadTen",
    rpcUrls: [devChain.rpcUrl],
  });
});

test("Typewriter exposes each storage root at one property layer", () => {
  const app = createTypewriterTest<typeof STORAGE_LAYOUT, typeof MUTATIONS>();
  type Root = StorageView<typeof STORAGE_LAYOUT, false>;

  expectTypeOf(app.state).toEqualTypeOf<Root["state"]>();
  expectTypeOf(app.accounts).toEqualTypeOf<Root["accounts"]>();
  expectTypeOf<Root["state"]["totalSupply"]>().toEqualTypeOf<bigint>();
  expectTypeOf<Root["accounts"][Hex.Hex]>().toEqualTypeOf<bigint>();
});

test("Typewriter mutation input uses concrete authorization", () => {
  const app = createTypewriterTest<typeof STORAGE_LAYOUT, typeof MUTATIONS>();
  type Input = Parameters<typeof app.execute>[0];

  expectTypeOf<Input>().toEqualTypeOf<
    TypewriterMutationInput<typeof MUTATIONS>
  >();

  const ping = {
    name: "Ping",
    params: { amount: 1n },
    authorization: AUTHORIZATION,
  } satisfies Input;
  const createAccount = {
    name: "CreateAccount",
    params: { keyType: 2, publicKey: "0x03" },
    authorization: AUTHORIZATION,
  } satisfies Input;

  expectTypeOf(ping).toMatchTypeOf<Extract<Input, { name: "Ping" }>>();
  expectTypeOf(createAccount).toMatchTypeOf<
    Extract<Input, { name: "CreateAccount" }>
  >();

  const acceptInput = (_input: Input) => {};
  acceptInput({
    name: "CreateAccount",
    // @ts-expect-error Native key types are limited to the protocol's three algorithms.
    params: { keyType: 3, publicKey: "0x03" },
    authorization: AUTHORIZATION,
  });
});

test("Typewriter sequencing type remains part of the handle", () => {
  const app = createTypewriterTest<
    typeof STORAGE_LAYOUT,
    typeof MUTATIONS,
    "batch"
  >();

  expectTypeOf(app).toEqualTypeOf<
    Typewriter<typeof STORAGE_LAYOUT, typeof MUTATIONS, "batch">
  >();
});
