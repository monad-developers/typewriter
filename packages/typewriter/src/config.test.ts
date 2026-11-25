import { expect, expectTypeOf, test } from "bun:test";
import type { Hex } from "ox";
import type { StorageView } from "storage-layout";
import type { LocalAccount } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  createTypewriterApp,
  type DevChain,
  deployedApp,
  type MutationsConfig,
  type SequencingConfig,
  type StorageConfig,
  type TypewriterConfig,
  validateConfig,
} from "./config";
import type {
  Authorization,
  createTypewriter,
  Typewriter,
  TypewriterMutationInput,
} from "./index";
import type { TypewriterSolidityEntrypoint } from "./sol-build";
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
  expiration: 0,
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
  deployment: "app_1",
  root: "0x00000000000000000000000000000000000000aa",
  scheduler: {} as LocalAccount,
  chainId: 1,
  rpcUrl: "http://localhost:8545",
  database: { url: "postgres://postgres@localhost:5432/postgres" },
} as const satisfies TypewriterConfig;

const ADDRESS = "0x0000000000000000000000000000000000000001";

const SOLIDITY_APP = {
  contractName: "Test",
  abi: [],
  bytecode: "0x00",
  storageLayout: STORAGE_LAYOUT,
  mutations: MUTATIONS,
} as const;

test("createTypewriterApp names the deployment and its schema from the config, and deployedApp constructs a serializable manifest", () => {
  const app = createTypewriterApp({ ...SOLIDITY_APP, config: publicConfig });

  expect(app.deployment).toBe("app_1");
  expect(app.database).toEqual(publicConfig.database);
  expect(app.root).toBe(publicConfig.root);
  expect(deployedApp(app, ADDRESS).manifest).toEqual({
    chainId: 1,
    address: ADDRESS,
    deployment: "app_1",
    mutations: MUTATIONS,
  });
});

test("validateConfig lists every missing network field outside dev", () => {
  expect(() => validateConfig({ database: publicConfig.database })).toThrow(
    "config.deployment, config.root, config.scheduler, config.chainId, config.rpcUrl are required unless config.dev is set",
  );
  const { deployment: _, ...withoutDeployment } = publicConfig;
  expect(() => validateConfig(withoutDeployment)).toThrow(
    "config.deployment is required unless config.dev is set",
  );
});

test("validateConfig rejects network fields and a deployment in dev", () => {
  expect(() =>
    validateConfig({
      dev: true,
      deployment: publicConfig.deployment,
      root: publicConfig.root,
      rpcUrl: publicConfig.rpcUrl,
      database: publicConfig.database,
    }),
  ).toThrow(
    "config.dev starts its own Anvil and deployment, so leave config.deployment, config.root, config.rpcUrl unset",
  );
  expect(() =>
    validateConfig({
      dev: true,
      relayer: publicConfig.scheduler,
      database: publicConfig.database,
    }),
  ).toThrow(
    "config.dev starts its own Anvil and deployment, so leave config.relayer unset",
  );
});

test("validateConfig takes only plain lowercase deployment names that Postgres keeps whole", () => {
  const withDeployment = (deployment: string) => () =>
    validateConfig({ ...publicConfig, deployment });

  expect(withDeployment("order_book_testnet_1")).not.toThrow();
  expect(withDeployment("_x")).not.toThrow();
  expect(withDeployment("a".repeat(63))).not.toThrow();
  for (const deployment of [
    "",
    "Order_book",
    "1_app",
    "app-1",
    "app 1",
    "pg_app",
  ]) {
    expect(withDeployment(deployment)).toThrow(
      `config.deployment must be lowercase letters, digits, and underscores, start with a letter or underscore, and not start with pg_, but is ${JSON.stringify(deployment)}`,
    );
  }
  expect(withDeployment("a".repeat(64))).toThrow(
    "config.deployment must be at most 63 characters",
  );
});

test("validateConfig rejects a root that is not an address", () => {
  expect(() =>
    validateConfig({ ...publicConfig, root: "0x1234" as Hex.Hex }),
  ).toThrow('config.root must be an address, but is "0x1234"');
});

test("createTypewriterApp takes the network from the dev chain", () => {
  const account = privateKeyToAccount(`0x${"33".repeat(32)}`);
  const devChain: DevChain = {
    account,
    chainId: 31337,
    hardfork: "MonadTen",
    rpcUrl: "http://127.0.0.1:8545",
  };
  const app = createTypewriterApp({
    ...SOLIDITY_APP,
    config: { dev: true, database: publicConfig.database },
    devChain,
  });

  // Each dev process gets its own deployment, schema, and browser storage.
  expect(app.deployment).toMatch(/^typewriter_dev_[0-9a-f]{12}$/);
  expect(deployedApp(app, ADDRESS).manifest.deployment).toBe(app.deployment);
  expect(app.root).toBe(account.address);
  expect(app.scheduler).toBe(account);
  expect(app.relayer).toBe(account);
  expect(app).toMatchObject({
    dev: true,
    chainId: 31337,
    hardfork: "MonadTen",
    rpcUrls: [devChain.rpcUrl],
  });
});

test("createTypewriter types the network fields by dev", () => {
  // Type checks only: the calls never run.
  const check = (
    create: typeof createTypewriter,
    entrypoint: TypewriterSolidityEntrypoint,
    envDev: boolean,
  ) => {
    const { deployment, root, scheduler, chainId, rpcUrl, database } =
      publicConfig;
    const chain = { deployment, root, scheduler, chainId, rpcUrl };

    create(entrypoint, { dev: true, database });
    create(entrypoint, { ...chain, database });
    create(entrypoint, { dev: false, ...chain, database });
    create(entrypoint, { ...chain, relayer: scheduler, database });
    create(entrypoint, {
      ...chain,
      // @ts-expect-error typewriter deploys the contract, and resumes it by its deployment
      address: ADDRESS,
      database,
    });
    // A `dev` typed as `boolean` leaves the check to `validateConfig`.
    create(entrypoint, { dev: envDev, root: undefined, database });
    create(entrypoint, { dev: envDev, database });

    // @ts-expect-error dev mode starts its own chain
    create(entrypoint, { dev: true, chainId, database });
    // @ts-expect-error dev mode makes its own deployment
    create(entrypoint, { dev: true, deployment, database });
    // @ts-expect-error dev mode makes Anvil's account the root
    create(entrypoint, { dev: true, root, database });
    // @ts-expect-error dev mode schedules with Anvil's account
    create(entrypoint, { dev: true, scheduler, database });
    // @ts-expect-error dev mode relays with Anvil's account
    create(entrypoint, { dev: true, relayer: scheduler, database });
    // @ts-expect-error a deployment needs every network field
    create(entrypoint, { database });
    // @ts-expect-error a deployment needs a name
    create(entrypoint, { root, scheduler, chainId, rpcUrl, database });
    // @ts-expect-error a deployment needs a root
    create(entrypoint, { deployment, scheduler, chainId, rpcUrl, database });
    // @ts-expect-error a relayer doesn't stand in for the scheduler
    create(entrypoint, {
      deployment,
      root,
      relayer: scheduler,
      chainId,
      rpcUrl,
      database,
    });
  };
  expect(check).toBeFunction();
});

test("Typewriter exposes each storage root at one property layer", () => {
  const app = createTypewriterTest<typeof STORAGE_LAYOUT, typeof MUTATIONS>();
  type Root = StorageView<typeof STORAGE_LAYOUT, false>;

  expectTypeOf(app.state).toEqualTypeOf<Root["state"]>();
  expectTypeOf(app.accounts).toEqualTypeOf<Root["accounts"]>();
  expectTypeOf<Root["state"]["totalSupply"]>().toEqualTypeOf<bigint>();
  expectTypeOf<Root["accounts"][Hex.Hex]>().toEqualTypeOf<bigint>();
});

test("Typewriter mutation input is the signed mutation and its signature", () => {
  const app = createTypewriterTest<typeof STORAGE_LAYOUT, typeof MUTATIONS>();
  type Input = Parameters<typeof app.execute>[0];

  expectTypeOf<Input>().toEqualTypeOf<
    TypewriterMutationInput<typeof MUTATIONS>
  >();

  const { signature, ...fields } = AUTHORIZATION;
  const ping = {
    mutation: { name: "Ping", params: { amount: 1n }, ...fields },
    signature,
  } satisfies Input;
  const createAccount = {
    mutation: {
      name: "CreateAccount",
      params: { keyType: 2, publicKey: "0x03" },
      ...fields,
    },
    signature,
  } satisfies Input;

  expectTypeOf(ping).toMatchTypeOf<
    Extract<Input, { mutation: { name: "Ping" } }>
  >();
  expectTypeOf(createAccount).toMatchTypeOf<
    Extract<Input, { mutation: { name: "CreateAccount" } }>
  >();

  const acceptInput = (_input: Input) => {};
  acceptInput({
    mutation: {
      name: "CreateAccount",
      // @ts-expect-error Native key types are limited to the protocol's three algorithms.
      params: { keyType: 3, publicKey: "0x03" },
      ...fields,
    },
    signature,
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
