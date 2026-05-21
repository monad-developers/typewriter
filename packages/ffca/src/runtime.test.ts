import { expect, test } from "bun:test";
import { parseAbiParameters } from "abitype";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sql/postgres";
import { Effect } from "effect";
import type { Hex } from "viem";
import { anvil } from "viem/chains";
import {
  ALICE_ACCOUNT,
  ALICE_PRIVATE_KEY,
  BOB_ACCOUNT,
  BOB_PRIVATE_KEY,
  P256_PRIVATE_KEY,
  SCHEDULER_ACCOUNT,
  TEST_CLIENT,
  TEST_DB_CONNECTION,
  TEST_DB_URL,
  TEST_PUBLIC_CLIENT,
  TEST_RPC_URL,
  TEST_WALLET_CLIENT,
  USER_ACCOUNT,
  USER_PRIVATE_KEY,
} from "../test/setup";
import {
  COUNTER_ABI,
  COUNTER_DOMAIN,
  COUNTER_MUTATIONS,
  COUNTER_STORAGE_LAYOUT,
  deployCounter,
  deployHarness,
  EMPTY_STORAGE_LAYOUT,
  HARNESS_ABI,
  HARNESS_DOMAIN,
  HARNESS_MUTATIONS,
  HARNESS_PERSISTED_MUTATIONS,
  HARNESS_SCHEMA,
  HARNESS_STORAGE_LAYOUT,
  type HarnessState,
  harnessAccounts,
  harnessBalances,
  harnessCreditMutations,
  harnessDebitMutations,
  harnessInitializeMutations,
  harnessKeys,
  harnessNonces,
  loadHarnessState,
  p256PublicKey,
  STUB_FFCA_ABI,
  secp256k1PublicKey,
  setupHarnessAccount,
  signCounter,
  signHarness,
  testMutationSchema,
} from "../test/utils";
import type { FFCAConfig } from "./config";
import { encodeMutationCalldata } from "./encoding";
import { createFFCA as createFFCARaw } from "./index";
import type { FFCA } from "./runtime";
import type { BlockEvent, BundleEvent, MutationEvent } from "./types";

async function createFFCA<
  const C extends Omit<FFCAConfig, "database"> & { database?: unknown },
>(config: C): Promise<FFCA<C["storageLayout"]>> {
  const { database: _database, ...rest } = config;
  return createFFCARaw({
    ...rest,
    database: { url: TEST_DB_URL, maxConnections: 2 },
  } as FFCAConfig) as Promise<FFCA<C["storageLayout"]>>;
}

// Small inline mutation for the shape-checking tests, kept independent of
// Harness/Counter so their evolving param lists don't drift these.
const SHAPE_MUTATION = {
  tag: 0,
  table: testMutationSchema,
  params: parseAbiParameters("address account, uint256 amount"),
};

test("ffca.domain is derived from config", async () => {
  const ffca = await createFFCA({
    address: "0x000000000000000000000000000000000000abcd",
    abi: STUB_FFCA_ABI,
    storageLayout: EMPTY_STORAGE_LAYOUT,
    // biome-ignore lint/suspicious/noExplicitAny: stub field, types not the focus
    account: {} as any,
    chainId: 1,
    rpcUrl: TEST_RPC_URL,
    domain: { name: "my-app", version: "2" },
    mutations: {},
  });

  expect(ffca.domain).toMatchInlineSnapshot(`
    {
      "chainId": 1,
      "name": "my-app",
      "verifyingContract": "0x000000000000000000000000000000000000abcd",
      "version": "2",
    }
  `);

  await ffca.stop();
});

test("createFFCA rejects partially configured persistence", async () => {
  await expect(
    createFFCA({
      address: "0x000000000000000000000000000000000000abcd",
      abi: STUB_FFCA_ABI,
      storageLayout: EMPTY_STORAGE_LAYOUT,
      // biome-ignore lint/suspicious/noExplicitAny: stub field, types not the focus
      account: {} as any,
      chainId: 1,
      rpcUrl: TEST_RPC_URL,
      domain: { name: "my-app", version: "2" },
      state: { schema: HARNESS_SCHEMA },
      mutations: { shape: SHAPE_MUTATION },
    }),
  ).rejects.toThrow(/persistence must be fully configured/);
});

test("createFFCA loads persisted state before returning", async () => {
  const account =
    "0x0000000000000000000000000000000000000000000000000000000000000001" as Hex;
  const loadedState: HarnessState = {
    accounts: { [account]: { keys: [], nonces: {} } },
    balances: { [account]: 42n },
  };
  const ffca = await createFFCA({
    address: "0x000000000000000000000000000000000000ffca",
    abi: STUB_FFCA_ABI,
    storageLayout: HARNESS_STORAGE_LAYOUT,
    // biome-ignore lint/suspicious/noExplicitAny: stub field, types not the focus
    account: {} as any,
    chainId: 31337,
    rpcUrl: TEST_RPC_URL,
    domain: HARNESS_DOMAIN,
    database: { connection: TEST_DB_CONNECTION },
    state: {
      schema: HARNESS_SCHEMA,
      load: () => Effect.succeed(loadedState),
    },
    mutations: { initialize: HARNESS_PERSISTED_MUTATIONS.initialize },
  });

  expect(await ffca.state.balances[account]).toBe(42n);

  await ffca.stop();
});

test("bundle applies mutations in config.sequence order within a bundle", async () => {
  const applied: string[] = [];
  const noop = parseAbiParameters("uint256 nonce");
  const ffca = await createFFCA({
    address: "0x0000000000000000000000000000000000000000",
    abi: STUB_FFCA_ABI,
    storageLayout: EMPTY_STORAGE_LAYOUT,
    account: SCHEDULER_ACCOUNT,
    chainId: anvil.id,
    rpcUrl: TEST_RPC_URL,
    domain: { name: "ffca-test", version: "1" },
    sequence: ["cancel", "limit", "market"],
    mutations: {
      cancel: {
        tag: 0,
        table: testMutationSchema,
        params: noop,
      },
      limit: {
        tag: 1,
        table: testMutationSchema,
        params: noop,
      },
      market: {
        tag: 2,
        table: testMutationSchema,
        params: noop,
      },
    },
  });
  ffca.on("mutation", (event) => {
    if (event.status === "accepted") applied.push(event.name);
  });

  // Submit out of order; queue together so they land in the same bundle.
  await Promise.all([
    ffca.execute({
      name: "market",
      args: { nonce: 1n },
      signature: { keyType: 0, rawSignature: "0x" },
    }),
    ffca.execute({
      name: "cancel",
      args: { nonce: 2n },
      signature: { keyType: 0, rawSignature: "0x" },
    }),
    ffca.execute({
      name: "limit",
      args: { nonce: 3n },
      signature: { keyType: 0, rawSignature: "0x" },
    }),
    ffca.execute({
      name: "limit",
      args: { nonce: 4n },
      signature: { keyType: 0, rawSignature: "0x" },
    }),
    ffca.execute({
      name: "cancel",
      args: { nonce: 5n },
      signature: { keyType: 0, rawSignature: "0x" },
    }),
  ]);

  expect(applied).toEqual(["cancel", "cancel", "limit", "limit", "market"]);

  await ffca.stop();
});

test("resolve receives submitted signature and execute returns accepted event", async () => {
  const signatures: unknown[] = [];
  const signature = { keyType: 7, rawSignature: "0x1234" };
  const mutation = {
    tag: 0,
    table: testMutationSchema,
    params: parseAbiParameters("uint256 amount"),
    resolution: parseAbiParameters("uint8 keyType"),
    resolve: ({ signature: submittedSignature }: { signature: unknown }) => {
      signatures.push(submittedSignature);
      return { keyType: signature.keyType };
    },
  };
  const ffca = await createFFCA({
    address: "0x0000000000000000000000000000000000000000",
    abi: STUB_FFCA_ABI,
    storageLayout: EMPTY_STORAGE_LAYOUT,
    account: SCHEDULER_ACCOUNT,
    chainId: 1,
    rpcUrl: TEST_RPC_URL,
    domain: { name: "ffca-test", version: "1" },
    mutations: {
      shape: mutation,
    },
  });

  const result = await ffca.execute({
    name: "shape",
    args: { amount: 5n },
    signature,
  });

  expect(signatures).toEqual([signature]);
  expect(result.status).toBe("accepted");

  await ffca.stop();
});

test("Harness revm rejects invalid signatures", async () => {
  const address = await deployHarness();
  const abi = HARNESS_ABI;
  const ffca = await createFFCA({
    address,
    domain: HARNESS_DOMAIN,
    abi,
    storageLayout: HARNESS_STORAGE_LAYOUT,
    account: SCHEDULER_ACCOUNT,
    chainId: anvil.id,
    rpcUrl: TEST_RPC_URL,
    state: {},
    mutations: HARNESS_MUTATIONS,
  });

  const rootPublicKey = secp256k1PublicKey(USER_ACCOUNT.address);
  const account = await setupHarnessAccount(ffca, {
    rootKeyType: 2,
    rootPublicKey,
  });

  await expect(
    ffca.execute({
      name: "credit",
      args: { account, keyId: 0n, amount: 1n, nonce: 0n },
      signature: {
        account,
        keyId: 0n,
        keyType: 2,
        rawSignature: signHarness({
          keyType: 2,
          privateKey: USER_PRIVATE_KEY,
          mutation: "credit",
          args: { account, keyId: 0n, amount: 2n, nonce: 0n },
          address,
          chainId: anvil.id,
        }),
      },
    }),
  ).rejects.toThrow(/InvalidSignature\(uint8 keyType\)[\s\S]*\(2\)/);

  expect(await ffca.state.balances[account]).toBe(0n);
  await ffca.stop();
});

// Counter: a single mutation, signed by the user, lands on chain.
// End-to-end through real EIP-712 signing and on-chain secp256k1 recovery.
test("e2e Counter: single mutation", async () => {
  const address = await deployCounter(USER_ACCOUNT.address);
  const abi = COUNTER_ABI;

  const ffca = await createFFCA({
    address,
    domain: COUNTER_DOMAIN,
    abi,
    storageLayout: COUNTER_STORAGE_LAYOUT,
    account: SCHEDULER_ACCOUNT,
    chainId: anvil.id,
    rpcUrl: TEST_RPC_URL,
    mutations: COUNTER_MUTATIONS,
  });

  const args = { amount: 7n, nonce: 0n };
  await ffca.execute({
    name: "add",
    args,
    signature: signCounter({
      privateKey: USER_PRIVATE_KEY,
      amount: args.amount,
      nonce: args.nonce,
      address,
      chainId: anvil.id,
    }),
  });

  const readTotal = async () => {
    const [total] = (await TEST_PUBLIC_CLIENT.readContract({
      abi,
      address,
      functionName: "state",
    })) as [bigint, bigint];
    return total;
  };
  const deadline = Date.now() + 5000;
  while ((await readTotal()) === 0n) {
    if (Date.now() > deadline) throw new Error("mutation never landed onchain");
    await new Promise((r) => setTimeout(r, 50));
  }

  expect(await readTotal()).toBe(7n);
  expect(await ffca.state.total).toBe(7n);

  await ffca.stop();
});

test.skip("e2e Counter: scheduler submits detected force inclusion", async () => {
  const address = await deployCounter(USER_ACCOUNT.address);
  const abi = COUNTER_ABI;

  const ffca = await createFFCA({
    address,
    domain: COUNTER_DOMAIN,
    abi,
    storageLayout: COUNTER_STORAGE_LAYOUT,
    account: SCHEDULER_ACCOUNT,
    chainId: anvil.id,
    rpcUrl: TEST_RPC_URL,
    sequencing: {
      order: "fifo",
      submitIntervalMs: 100,
      blockPollingIntervalMs: 50,
    },
    mutations: COUNTER_MUTATIONS,
  });

  await new Promise((resolve) => setTimeout(resolve, 1000));

  const forceArgs = { amount: 13n, nonce: 0n };
  const forceSignature = signCounter({
    privateKey: USER_PRIVATE_KEY,
    amount: forceArgs.amount,
    nonce: forceArgs.nonce,
    address,
    chainId: anvil.id,
  });
  await TEST_WALLET_CLIENT.writeContract({
    account: TEST_WALLET_CLIENT.account!,
    chain: anvil,
    address,
    abi,
    functionName: "enqueue",
    args: [
      COUNTER_MUTATIONS.add.tag,
      encodeMutationCalldata({
        id: 0,
        status: "accepted",
        name: "add",
        args: forceArgs,
        signature: forceSignature,
        isForceInclusion: true,
        config: COUNTER_MUTATIONS.add,
      }),
      forceSignature,
    ],
  });
  await new Promise((resolve) => setTimeout(resolve, 1500));

  const scheduledArgs = { amount: 7n, nonce: 1n };
  await ffca.execute({
    name: "add",
    args: scheduledArgs,
    signature: signCounter({
      privateKey: USER_PRIVATE_KEY,
      amount: scheduledArgs.amount,
      nonce: scheduledArgs.nonce,
      address,
      chainId: anvil.id,
    }),
  });

  const readState = async () =>
    (await TEST_PUBLIC_CLIENT.readContract({
      abi,
      address,
      functionName: "state",
    })) as [bigint, bigint];

  const deadline = Date.now() + 5000;
  while ((await readState())[0] !== 20n) {
    if (Date.now() > deadline) {
      throw new Error("force inclusion never landed onchain");
    }
    await new Promise((r) => setTimeout(r, 50));
  }

  expect(await readState()).toEqual([20n, 2n]);
  expect(await ffca.state.total).toBe(20n);
  expect(await ffca.state.nonce).toBe(2n);

  await ffca.stop();
});

// Counter: FIFO accepts each mutation as soon as it arrives, then the submit
// loop flushes the accepted mutations to chain together.
test("e2e Counter: FIFO accepts mutations before submit flush", async () => {
  const address = await deployCounter(USER_ACCOUNT.address);
  const abi = COUNTER_ABI;

  const ffca = await createFFCA({
    address,
    domain: COUNTER_DOMAIN,
    abi,
    storageLayout: COUNTER_STORAGE_LAYOUT,
    account: SCHEDULER_ACCOUNT,
    chainId: anvil.id,
    rpcUrl: TEST_RPC_URL,
    sequencing: { order: "fifo", submitIntervalMs: 1000 },
    mutations: COUNTER_MUTATIONS,
  });

  const acceptedBundles: BundleEvent[] = [];
  ffca.on("bundle", (event) => {
    if (event.status === "accepted") acceptedBundles.push(event);
  });

  const sign = (args: { amount: bigint; nonce: bigint }) =>
    signCounter({
      privateKey: USER_PRIVATE_KEY,
      amount: args.amount,
      nonce: args.nonce,
      address,
      chainId: anvil.id,
    });

  await Promise.all([
    ffca.execute({
      name: "add",
      args: { amount: 5n, nonce: 0n },
      signature: sign({ amount: 5n, nonce: 0n }),
    }),
    ffca.execute({
      name: "add",
      args: { amount: 7n, nonce: 1n },
      signature: sign({ amount: 7n, nonce: 1n }),
    }),
    ffca.execute({
      name: "add",
      args: { amount: 11n, nonce: 2n },
      signature: sign({ amount: 11n, nonce: 2n }),
    }),
  ]);

  expect(acceptedBundles.map((bundle) => bundle.mutations.length)).toEqual([
    1, 1, 1,
  ]);

  const readTotal = async () => {
    const [total] = (await TEST_PUBLIC_CLIENT.readContract({
      abi,
      address,
      functionName: "state",
    })) as [bigint, bigint];
    return total;
  };
  const deadline = Date.now() + 5000;
  while ((await readTotal()) === 0n) {
    if (Date.now() > deadline) throw new Error("bundle never landed onchain");
    await new Promise((r) => setTimeout(r, 50));
  }

  expect(await readTotal()).toBe(23n);
  expect(await ffca.state.total).toBe(23n);

  await ffca.stop();
});

// Harness: a debit's resolve runs against credited revm-backed state and the contract
// accepts the resolution. Exercises the resolve → encode → onchain verify path
// end-to-end through real EIP-712 signing + secp256k1 recovery.
test("e2e Harness: mutation with resolution", async () => {
  const address = await deployHarness();
  const abi = HARNESS_ABI;

  const ffca = await createFFCA({
    address,
    domain: HARNESS_DOMAIN,
    abi,
    storageLayout: HARNESS_STORAGE_LAYOUT,
    account: SCHEDULER_ACCOUNT,
    chainId: anvil.id,
    rpcUrl: TEST_RPC_URL,
    sequence: ["initialize", "credit", "debit"],
    mutations: {
      initialize: HARNESS_MUTATIONS.initialize,
      credit: HARNESS_MUTATIONS.credit,
      debit: HARNESS_MUTATIONS.debit,
    },
  });

  const rootPublicKey = secp256k1PublicKey(ALICE_ACCOUNT.address);
  const aliceId = await setupHarnessAccount(ffca, {
    rootKeyType: 2,
    rootPublicKey,
  });

  // Submit in dependency order; no `sequence` needed.
  await ffca.execute({
    name: "credit",
    args: { account: aliceId, keyId: 0n, amount: 100n, nonce: 0n },
    signature: {
      account: aliceId,
      keyId: 0n,
      keyType: 2,
      rawSignature: signHarness({
        privateKey: ALICE_PRIVATE_KEY,
        keyType: 2,
        mutation: "credit",
        args: { account: aliceId, keyId: 0n, amount: 100n, nonce: 0n },
        address,
        chainId: anvil.id,
      }),
    },
  });
  await ffca.execute({
    name: "debit",
    args: { account: aliceId, keyId: 0n, amount: 30n, nonce: 1n },
    signature: {
      account: aliceId,
      keyId: 0n,
      keyType: 2,
      rawSignature: signHarness({
        privateKey: ALICE_PRIVATE_KEY,
        keyType: 2,
        mutation: "debit",
        args: { account: aliceId, keyId: 0n, amount: 30n, nonce: 1n },
        address,
        chainId: anvil.id,
      }),
    },
  });

  const readBalance = () =>
    TEST_PUBLIC_CLIENT.readContract({
      abi,
      address,
      functionName: "balances",
      args: [aliceId],
    }) as Promise<bigint>;
  const deadline = Date.now() + 5000;
  while ((await readBalance()) !== 70n) {
    if (Date.now() > deadline) {
      throw new Error(`balance never reached 70; saw ${await readBalance()}`);
    }
    await new Promise((r) => setTimeout(r, 50));
  }

  expect(await readBalance()).toBe(70n);
  expect(await ffca.state.balances[aliceId]).toBe(70n);

  await ffca.stop();
});

test("e2e Harness: persistence callbacks write accepted state", async () => {
  const address = await deployHarness();
  const abi = HARNESS_ABI;

  const ffca = await createFFCA({
    address,
    domain: HARNESS_DOMAIN,
    abi,
    storageLayout: HARNESS_STORAGE_LAYOUT,
    account: SCHEDULER_ACCOUNT,
    chainId: anvil.id,
    rpcUrl: TEST_RPC_URL,
    database: { connection: TEST_DB_CONNECTION },
    state: {
      schema: HARNESS_SCHEMA,
      load: loadHarnessState,
    },
    mutations: {
      initialize: HARNESS_PERSISTED_MUTATIONS.initialize,
      credit: HARNESS_PERSISTED_MUTATIONS.credit,
      debit: HARNESS_PERSISTED_MUTATIONS.debit,
    },
  });
  const db = drizzle({
    client: TEST_DB_CONNECTION,
  });

  const rootPublicKey = secp256k1PublicKey(ALICE_ACCOUNT.address);
  const aliceId = await setupHarnessAccount(ffca, {
    rootKeyType: 2,
    rootPublicKey,
  });

  await ffca.execute({
    name: "credit",
    args: { account: aliceId, keyId: 0n, amount: 100n, nonce: 0n },
    signature: {
      account: aliceId,
      keyId: 0n,
      keyType: 2,
      rawSignature: signHarness({
        privateKey: ALICE_PRIVATE_KEY,
        keyType: 2,
        mutation: "credit",
        args: { account: aliceId, keyId: 0n, amount: 100n, nonce: 0n },
        address,
        chainId: anvil.id,
      }),
    },
  });
  await ffca.execute({
    name: "debit",
    args: { account: aliceId, keyId: 0n, amount: 30n, nonce: 1n },
    signature: {
      account: aliceId,
      keyId: 0n,
      keyType: 2,
      rawSignature: signHarness({
        privateKey: ALICE_PRIVATE_KEY,
        keyType: 2,
        mutation: "debit",
        args: { account: aliceId, keyId: 0n, amount: 30n, nonce: 1n },
        address,
        chainId: anvil.id,
      }),
    },
  });

  const readBalance = () =>
    TEST_PUBLIC_CLIENT.readContract({
      abi,
      address,
      functionName: "balances",
      args: [aliceId],
    }) as Promise<bigint>;
  const deadline = Date.now() + 5000;
  while ((await readBalance()) !== 70n) {
    if (Date.now() > deadline) {
      throw new Error(`balance never reached 70; saw ${await readBalance()}`);
    }
    await new Promise((r) => setTimeout(r, 50));
  }

  const [account] = await db
    .select()
    .from(harnessAccounts)
    .where(eq(harnessAccounts.id, aliceId));
  const [key] = await db
    .select()
    .from(harnessKeys)
    .where(eq(harnessKeys.account, aliceId));
  const [nonce] = await db
    .select()
    .from(harnessNonces)
    .where(eq(harnessNonces.account, aliceId));
  const [balance] = await db
    .select()
    .from(harnessBalances)
    .where(eq(harnessBalances.account, aliceId));
  const readPersistedMutations = async () => {
    const [initialize] = await db.select().from(harnessInitializeMutations);
    const [credit] = await db.select().from(harnessCreditMutations);
    const [debit] = await db.select().from(harnessDebitMutations);
    return { initialize, credit, debit };
  };
  const { initialize, credit, debit } = await readPersistedMutations();

  expect(account).toEqual({ id: aliceId });
  expect(key).toEqual({
    account: aliceId,
    keyIndex: 0n,
    keyType: 2,
    publicKey: rootPublicKey,
  });
  expect(nonce).toEqual({ account: aliceId, nonceKey: "0", sequence: 2n });
  expect(balance).toEqual({ account: aliceId, amount: "70" });
  expect(initialize).toMatchObject({
    id: 0,
    status: "accepted",
    account: aliceId,
    rootKeyType: 2,
    rootPublicKey,
  });
  expect(credit).toMatchObject({
    id: 1,
    status: "accepted",
    account: aliceId,
    amount: "100",
    nonce: "0",
  });
  expect(debit).toMatchObject({
    id: 2,
    status: "accepted",
    account: aliceId,
    amount: "30",
    nonce: "1",
    newBalance: "70",
  });
  expect(credit?.acceptedAt).not.toBeNull();
  expect(debit?.acceptedAt).not.toBeNull();

  await ffca.stop();
});

test("e2e Harness: authorize persistence writes per-mutation key rows", async () => {
  const address = await deployHarness();
  const abi = HARNESS_ABI;

  const ffca = await createFFCA({
    address,
    domain: HARNESS_DOMAIN,
    abi,
    storageLayout: HARNESS_STORAGE_LAYOUT,
    account: SCHEDULER_ACCOUNT,
    chainId: anvil.id,
    rpcUrl: TEST_RPC_URL,
    database: { connection: TEST_DB_CONNECTION },
    state: {
      schema: HARNESS_SCHEMA,
      load: loadHarnessState,
    },
    sequence: ["initialize", "authorize"],
    mutations: {
      initialize: HARNESS_PERSISTED_MUTATIONS.initialize,
      authorize: HARNESS_PERSISTED_MUTATIONS.authorize,
    },
  });
  const db = drizzle({
    client: TEST_DB_CONNECTION,
  });

  const rootPublicKey = secp256k1PublicKey(ALICE_ACCOUNT.address);
  const aliceId = await setupHarnessAccount(ffca, {
    rootKeyType: 2,
    rootPublicKey,
  });
  const bobPublicKey = secp256k1PublicKey(BOB_ACCOUNT.address);
  const p256Pk = p256PublicKey(P256_PRIVATE_KEY);
  const bobAuthorizeArgs = {
    account: aliceId,
    keyId: 1n,
    keyType: 2,
    publicKey: bobPublicKey,
    nonce: 0n,
  };
  const p256AuthorizeArgs = {
    account: aliceId,
    keyId: 2n,
    keyType: 0,
    publicKey: p256Pk,
    nonce: 1n,
  };

  await Promise.all([
    ffca.execute({
      name: "authorize",
      args: bobAuthorizeArgs,
      signature: {
        account: aliceId,
        keyId: 0n,
        keyType: 2,
        rawSignature: signHarness({
          privateKey: ALICE_PRIVATE_KEY,
          keyType: 2,
          mutation: "authorize",
          args: bobAuthorizeArgs,
          address,
          chainId: anvil.id,
        }),
      },
    }),
    ffca.execute({
      name: "authorize",
      args: p256AuthorizeArgs,
      signature: {
        account: aliceId,
        keyId: 0n,
        keyType: 2,
        rawSignature: signHarness({
          privateKey: ALICE_PRIVATE_KEY,
          keyType: 2,
          mutation: "authorize",
          args: p256AuthorizeArgs,
          address,
          chainId: anvil.id,
        }),
      },
    }),
  ]);

  const deadline = Date.now() + 5000;
  while (
    ((await TEST_PUBLIC_CLIENT.readContract({
      abi,
      address,
      functionName: "nonceOf",
      args: [aliceId, 0n],
    })) as bigint) !== 2n
  ) {
    if (Date.now() > deadline) {
      throw new Error("authorize bundle never landed");
    }
    await new Promise((r) => setTimeout(r, 50));
  }

  const keys = await db
    .select()
    .from(harnessKeys)
    .where(eq(harnessKeys.account, aliceId));
  keys.sort((a, b) => Number(a.keyIndex - b.keyIndex));

  expect(keys).toEqual([
    {
      account: aliceId,
      keyIndex: 0n,
      keyType: 2,
      publicKey: rootPublicKey,
    },
    {
      account: aliceId,
      keyIndex: 1n,
      keyType: 2,
      publicKey: bobPublicKey,
    },
    {
      account: aliceId,
      keyIndex: 2n,
      keyType: 0,
      publicKey: p256Pk,
    },
  ]);

  await ffca.stop();
});

// Harness: when mutations arrive out of order, `sequence` sorts them so the
// debit's resolve runs against post-credit state. If sort were broken, debit's
// resolve would underflow and the bundle would never encode.
test("e2e Harness: mutations reordered by sequence", async () => {
  const address = await deployHarness();
  const abi = HARNESS_ABI;

  const ffca = await createFFCA({
    address,
    domain: HARNESS_DOMAIN,
    abi,
    storageLayout: HARNESS_STORAGE_LAYOUT,
    account: SCHEDULER_ACCOUNT,
    chainId: anvil.id,
    rpcUrl: TEST_RPC_URL,
    sequence: ["initialize", "credit", "debit"],
    mutations: {
      initialize: HARNESS_MUTATIONS.initialize,
      credit: HARNESS_MUTATIONS.credit,
      debit: HARNESS_MUTATIONS.debit,
    },
  });

  const rootPublicKey = secp256k1PublicKey(ALICE_ACCOUNT.address);
  const aliceId = await setupHarnessAccount(ffca, {
    rootKeyType: 2,
    rootPublicKey,
  });

  // Submit debit before credit — sequence must sort credit first. Each
  // mutation signs over its own nonce; the contract's nonce check enforces
  // the post-sort order on chain.
  await Promise.all([
    ffca.execute({
      name: "debit",
      args: { account: aliceId, keyId: 0n, amount: 30n, nonce: 1n },
      signature: {
        account: aliceId,
        keyId: 0n,
        keyType: 2,
        rawSignature: signHarness({
          privateKey: ALICE_PRIVATE_KEY,
          keyType: 2,
          mutation: "debit",
          args: { account: aliceId, keyId: 0n, amount: 30n, nonce: 1n },
          address,
          chainId: anvil.id,
        }),
      },
    }),
    ffca.execute({
      name: "credit",
      args: { account: aliceId, keyId: 0n, amount: 100n, nonce: 0n },
      signature: {
        account: aliceId,
        keyId: 0n,
        keyType: 2,
        rawSignature: signHarness({
          privateKey: ALICE_PRIVATE_KEY,
          keyType: 2,
          mutation: "credit",
          args: { account: aliceId, keyId: 0n, amount: 100n, nonce: 0n },
          address,
          chainId: anvil.id,
        }),
      },
    }),
  ]);

  const readBalance = () =>
    TEST_PUBLIC_CLIENT.readContract({
      abi,
      address,
      functionName: "balances",
      args: [aliceId],
    }) as Promise<bigint>;
  const deadline = Date.now() + 5000;
  while ((await readBalance()) !== 70n) {
    if (Date.now() > deadline) {
      throw new Error(`balance never reached 70; saw ${await readBalance()}`);
    }
    await new Promise((r) => setTimeout(r, 50));
  }

  expect(await readBalance()).toBe(70n);
  expect(await ffca.state.balances[aliceId]).toBe(70n);

  await ffca.stop();
});

// Harness: a bad debit resolution rejects that mutation's execute() promise;
// sibling mutations in the same bundle still land.
test("e2e Harness: resolution error rejects one mutation", async () => {
  const address = await deployHarness();
  const abi = HARNESS_ABI;

  const ffca = await createFFCA({
    address,
    domain: HARNESS_DOMAIN,
    abi,
    storageLayout: HARNESS_STORAGE_LAYOUT,
    account: SCHEDULER_ACCOUNT,
    chainId: anvil.id,
    rpcUrl: TEST_RPC_URL,
    sequence: ["initialize", "credit", "debit"],
    mutations: {
      initialize: HARNESS_MUTATIONS.initialize,
      credit: HARNESS_MUTATIONS.credit,
      debit: HARNESS_MUTATIONS.debit,
    },
  });

  const aliceId = await setupHarnessAccount(ffca, {
    rootKeyType: 2,
    rootPublicKey: secp256k1PublicKey(ALICE_ACCOUNT.address),
  });
  const bobId = await setupHarnessAccount(ffca, {
    rootKeyType: 2,
    rootPublicKey: secp256k1PublicKey(BOB_ACCOUNT.address),
  });

  const readBalance = (account: Hex) =>
    TEST_PUBLIC_CLIENT.readContract({
      abi,
      address,
      functionName: "balances",
      args: [account],
    }) as Promise<bigint>;

  // Alice's debit fails (no balance); Bob's credit succeeds. Same bundle.
  await Promise.all([
    expect(
      ffca.execute({
        name: "debit",
        args: { account: aliceId, keyId: 0n, amount: 30n, nonce: 0n },
        signature: {
          account: aliceId,
          keyId: 0n,
          keyType: 2,
          rawSignature: signHarness({
            privateKey: ALICE_PRIVATE_KEY,
            keyType: 2,
            mutation: "debit",
            args: { account: aliceId, keyId: 0n, amount: 30n, nonce: 0n },
            address,
            chainId: anvil.id,
          }),
        },
      }),
    ).rejects.toThrow(/safe 256-bit unsigned integer range/),
    ffca.execute({
      name: "credit",
      args: { account: bobId, keyId: 0n, amount: 50n, nonce: 0n },
      signature: {
        account: bobId,
        keyId: 0n,
        keyType: 2,
        rawSignature: signHarness({
          privateKey: BOB_PRIVATE_KEY,
          keyType: 2,
          mutation: "credit",
          args: { account: bobId, keyId: 0n, amount: 50n, nonce: 0n },
          address,
          chainId: anvil.id,
        }),
      },
    }),
  ]);

  const deadline = Date.now() + 5000;
  while ((await readBalance(bobId)) === 0n) {
    if (Date.now() > deadline) {
      throw new Error("credit never landed onchain");
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  expect(await readBalance(bobId)).toBe(50n);
  expect(await readBalance(aliceId)).toBe(0n);

  expect(await ffca.state.balances[bobId]).toBe(50n);
  expect(await ffca.state.balances[aliceId]).toBe(0n);

  await ffca.stop();
});

// Harness: an account initialized with a secp256k1 root key authorizes a
// second secp256k1 key, then a mutation signed by *the second key* lands on
// chain. Proves the multi-key registry path end-to-end: the contract picks
// the right key by keyId and dispatches verification correctly.
test("e2e Harness: secp256k1 authorize flow", async () => {
  const address = await deployHarness();
  const abi = HARNESS_ABI;

  const ffca = await createFFCA({
    address,
    domain: HARNESS_DOMAIN,
    abi,
    storageLayout: HARNESS_STORAGE_LAYOUT,
    account: SCHEDULER_ACCOUNT,
    chainId: anvil.id,
    rpcUrl: TEST_RPC_URL,
    sequence: ["initialize", "authorize", "credit"],
    mutations: {
      initialize: HARNESS_MUTATIONS.initialize,
      authorize: HARNESS_MUTATIONS.authorize,
      credit: HARNESS_MUTATIONS.credit,
    },
  });

  // Alice's EOA is the root key; Bob's EOA is the second key authorized
  // under Alice's account.
  const aliceId = await setupHarnessAccount(ffca, {
    rootKeyType: 2,
    rootPublicKey: secp256k1PublicKey(ALICE_ACCOUNT.address),
  });
  const bobPublicKey = secp256k1PublicKey(BOB_ACCOUNT.address);

  // authorize: signed by the root key (keyId=0). The mutation adds Bob's
  // key as keyId=1 to Alice's account.
  const authorizeArgs = {
    account: aliceId,
    keyId: 1n,
    keyType: 2,
    publicKey: bobPublicKey,
    nonce: 0n,
  };
  await ffca.execute({
    name: "authorize",
    args: authorizeArgs,
    signature: {
      account: aliceId,
      keyId: 0n,
      keyType: 2,
      rawSignature: signHarness({
        privateKey: ALICE_PRIVATE_KEY,
        keyType: 2,
        mutation: "authorize",
        args: authorizeArgs,
        address,
        chainId: anvil.id,
      }),
    },
  });

  // credit: signed by Bob's key (keyId=1) on Alice's account.
  const creditArgs = {
    account: aliceId,
    keyId: 1n,
    amount: 100n,
    nonce: 1n,
  };
  await ffca.execute({
    name: "credit",
    args: creditArgs,
    signature: {
      account: aliceId,
      keyId: 1n,
      keyType: 2,
      rawSignature: signHarness({
        privateKey: BOB_PRIVATE_KEY,
        keyType: 2,
        mutation: "credit",
        args: creditArgs,
        address,
        chainId: anvil.id,
      }),
    },
  });

  const readBalance = () =>
    TEST_PUBLIC_CLIENT.readContract({
      abi,
      address,
      functionName: "balances",
      args: [aliceId],
    }) as Promise<bigint>;
  const deadline = Date.now() + 5000;
  while ((await readBalance()) === 0n) {
    if (Date.now() > deadline) {
      throw new Error(`balance never reached 100; saw ${await readBalance()}`);
    }
    await new Promise((r) => setTimeout(r, 50));
  }

  expect(await readBalance()).toBe(100n);

  // Verify both keys registered and the nonce sequence advanced past two
  // signed mutations (authorize + credit).
  const [keyType0, pk0] = (await TEST_PUBLIC_CLIENT.readContract({
    abi,
    address,
    functionName: "keyOf",
    args: [aliceId, 0n],
  })) as [number, Hex];
  expect(keyType0).toBe(2);
  expect(pk0).toBe(secp256k1PublicKey(ALICE_ACCOUNT.address));

  const [keyType1, pk1] = (await TEST_PUBLIC_CLIENT.readContract({
    abi,
    address,
    functionName: "keyOf",
    args: [aliceId, 1n],
  })) as [number, Hex];
  expect(keyType1).toBe(2);
  expect(pk1).toBe(bobPublicKey);

  const nonceSeq = (await TEST_PUBLIC_CLIENT.readContract({
    abi,
    address,
    functionName: "nonceOf",
    args: [aliceId, 0n],
  })) as bigint;
  expect(nonceSeq).toBe(2n);

  await ffca.stop();
});

// Harness: an account authorizes a P-256 key, then a credit signed by it
// lands on chain. Proves the on-chain RIP-7212 P-256 verifier (precompile
// at address 0x100) integrates end-to-end through ffca's wire format.
test("e2e Harness: P-256 key authorize and credit", async () => {
  const address = await deployHarness();
  const abi = HARNESS_ABI;

  const ffca = await createFFCA({
    address,
    domain: HARNESS_DOMAIN,
    abi,
    storageLayout: HARNESS_STORAGE_LAYOUT,
    account: SCHEDULER_ACCOUNT,
    chainId: anvil.id,
    rpcUrl: TEST_RPC_URL,
    sequence: ["initialize", "authorize", "credit"],
    mutations: {
      initialize: HARNESS_MUTATIONS.initialize,
      authorize: HARNESS_MUTATIONS.authorize,
      credit: HARNESS_MUTATIONS.credit,
    },
  });

  // Alice's secp256k1 EOA is the root key; the P-256 key gets authorized
  // under it as keyId=1.
  const aliceId = await setupHarnessAccount(ffca, {
    rootKeyType: 2,
    rootPublicKey: secp256k1PublicKey(ALICE_ACCOUNT.address),
  });
  const p256Pk = p256PublicKey(P256_PRIVATE_KEY);

  // authorize: signed by the secp256k1 root key.
  const authorizeArgs = {
    account: aliceId,
    keyId: 1n,
    keyType: 0,
    publicKey: p256Pk,
    nonce: 0n,
  };
  await ffca.execute({
    name: "authorize",
    args: authorizeArgs,
    signature: {
      account: aliceId,
      keyId: 0n,
      keyType: 2,
      rawSignature: signHarness({
        privateKey: ALICE_PRIVATE_KEY,
        keyType: 2,
        mutation: "authorize",
        args: authorizeArgs,
        address,
        chainId: anvil.id,
      }),
    },
  });

  // credit: signed by the P-256 key.
  const creditArgs = {
    account: aliceId,
    keyId: 1n,
    amount: 100n,
    nonce: 1n,
  };
  await ffca.execute({
    name: "credit",
    args: creditArgs,
    signature: {
      account: aliceId,
      keyId: 1n,
      keyType: 0,
      rawSignature: signHarness({
        privateKey: P256_PRIVATE_KEY,
        keyType: 0,
        mutation: "credit",
        args: creditArgs,
        address,
        chainId: anvil.id,
      }),
    },
  });

  const readBalance = () =>
    TEST_PUBLIC_CLIENT.readContract({
      abi,
      address,
      functionName: "balances",
      args: [aliceId],
    }) as Promise<bigint>;
  const deadline = Date.now() + 5000;
  while ((await readBalance()) === 0n) {
    if (Date.now() > deadline) {
      throw new Error(`balance never reached 100; saw ${await readBalance()}`);
    }
    await new Promise((r) => setTimeout(r, 50));
  }

  expect(await readBalance()).toBe(100n);

  const [keyType1, pk1] = (await TEST_PUBLIC_CLIENT.readContract({
    abi,
    address,
    functionName: "keyOf",
    args: [aliceId, 1n],
  })) as [number, Hex];
  expect(keyType1).toBe(0);
  expect(pk1).toBe(p256Pk);

  await ffca.stop();
});

// Harness: an account authorizes a WebAuthn-P256 key, then a credit signed
// by it lands on chain. End-to-end through the full WebAuthn ritual:
// authenticatorData + clientDataJSON + base64url-encoded challenge,
// verified on-chain via the RIP-7212 precompile.
test("e2e Harness: WebAuthn-P256 key authorize and credit", async () => {
  const address = await deployHarness();
  const abi = HARNESS_ABI;

  const ffca = await createFFCA({
    address,
    domain: HARNESS_DOMAIN,
    abi,
    storageLayout: HARNESS_STORAGE_LAYOUT,
    account: SCHEDULER_ACCOUNT,
    chainId: anvil.id,
    rpcUrl: TEST_RPC_URL,
    sequence: ["initialize", "authorize", "credit"],
    mutations: {
      initialize: HARNESS_MUTATIONS.initialize,
      authorize: HARNESS_MUTATIONS.authorize,
      credit: HARNESS_MUTATIONS.credit,
    },
  });

  const aliceId = await setupHarnessAccount(ffca, {
    rootKeyType: 2,
    rootPublicKey: secp256k1PublicKey(ALICE_ACCOUNT.address),
  });
  // P-256 key material is the same for plain P-256 and WebAuthn-P256 — only
  // the signing ritual differs.
  const webauthnPk = p256PublicKey(P256_PRIVATE_KEY);

  const authorizeArgs = {
    account: aliceId,
    keyId: 1n,
    keyType: 1,
    publicKey: webauthnPk,
    nonce: 0n,
  };
  await ffca.execute({
    name: "authorize",
    args: authorizeArgs,
    signature: {
      account: aliceId,
      keyId: 0n,
      keyType: 2,
      rawSignature: signHarness({
        privateKey: ALICE_PRIVATE_KEY,
        keyType: 2,
        mutation: "authorize",
        args: authorizeArgs,
        address,
        chainId: anvil.id,
      }),
    },
  });

  const creditArgs = {
    account: aliceId,
    keyId: 1n,
    amount: 100n,
    nonce: 1n,
  };
  await ffca.execute({
    name: "credit",
    args: creditArgs,
    signature: {
      account: aliceId,
      keyId: 1n,
      keyType: 1,
      rawSignature: signHarness({
        privateKey: P256_PRIVATE_KEY,
        keyType: 1,
        mutation: "credit",
        args: creditArgs,
        address,
        chainId: anvil.id,
      }),
    },
  });

  const readBalance = () =>
    TEST_PUBLIC_CLIENT.readContract({
      abi,
      address,
      functionName: "balances",
      args: [aliceId],
    }) as Promise<bigint>;
  const deadline = Date.now() + 5000;
  while ((await readBalance()) === 0n) {
    if (Date.now() > deadline) {
      throw new Error(`balance never reached 100; saw ${await readBalance()}`);
    }
    await new Promise((r) => setTimeout(r, 50));
  }

  expect(await readBalance()).toBe(100n);

  const [keyType1] = (await TEST_PUBLIC_CLIENT.readContract({
    abi,
    address,
    functionName: "keyOf",
    args: [aliceId, 1n],
  })) as [number, Hex];
  expect(keyType1).toBe(1);

  await ffca.stop();
});

// Fan-out: a single happy-path mutation produces the full lifecycle of events
// to subscribers — submitted/accepted/included for the mutation,
// accepted/included for its bundle and block. Off-then-on confirms unsubscribe
// works.
test("e2e Counter: subscribers receive lifecycle events", async () => {
  const address = await deployCounter(USER_ACCOUNT.address);
  const abi = COUNTER_ABI;

  const ffca = await createFFCA({
    address,
    domain: COUNTER_DOMAIN,
    abi,
    storageLayout: COUNTER_STORAGE_LAYOUT,
    account: SCHEDULER_ACCOUNT,
    chainId: anvil.id,
    rpcUrl: TEST_RPC_URL,
    mutations: COUNTER_MUTATIONS,
  });

  const mutationStatuses: MutationEvent["status"][] = [];
  const bundleStatuses: BundleEvent["status"][] = [];
  const blockStatuses: BlockEvent["status"][] = [];

  const offMutation = ffca.on("mutation", (e) =>
    mutationStatuses.push(e.status),
  );
  ffca.on("bundle", (e) => bundleStatuses.push(e.status));
  ffca.on("block", (e) => blockStatuses.push(e.status));

  const sign = (args: { amount: bigint; nonce: bigint }) =>
    signCounter({
      privateKey: USER_PRIVATE_KEY,
      amount: args.amount,
      nonce: args.nonce,
      address,
      chainId: anvil.id,
    });

  await ffca.execute({
    name: "add",
    args: { amount: 7n, nonce: 0n },
    signature: sign({ amount: 7n, nonce: 0n }),
  });

  // Wait for the included events (submit cycle adds ~400ms after accept).
  const deadline = Date.now() + 5000;
  while (
    !mutationStatuses.includes("included") ||
    !blockStatuses.includes("included")
  ) {
    if (Date.now() > deadline) {
      throw new Error("included events never arrived");
    }
    await new Promise((r) => setTimeout(r, 50));
  }

  expect(mutationStatuses).toEqual(["submitted", "accepted", "included"]);
  expect(bundleStatuses).toEqual(["accepted", "included"]);
  expect(blockStatuses).toEqual(["included"]);

  // The disposer returned by on() unsubscribes that listener.
  offMutation();
  await ffca.execute({
    name: "add",
    args: { amount: 3n, nonce: 1n },
    signature: sign({ amount: 3n, nonce: 1n }),
  });
  while (bundleStatuses.length < 4) {
    if (Date.now() > deadline) {
      throw new Error("second bundle's included event never arrived");
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  // Same three statuses as before — no new mutation events after unsubscribe.
  expect(mutationStatuses).toEqual(["submitted", "accepted", "included"]);

  await ffca.stop();
});

test("e2e Counter: watch advances included bundles by configured block depths", async () => {
  const address = await deployCounter(USER_ACCOUNT.address);
  const abi = COUNTER_ABI;

  const ffca = await createFFCA({
    address,
    domain: COUNTER_DOMAIN,
    abi,
    storageLayout: COUNTER_STORAGE_LAYOUT,
    account: SCHEDULER_ACCOUNT,
    chainId: anvil.id,
    rpcUrl: TEST_RPC_URL,
    mutations: COUNTER_MUTATIONS,
    confirmations: { safeBlockDepth: 1, finalizedBlockDepth: 3 },
  });

  const mutationStatuses: MutationEvent["status"][] = [];
  const bundleStatuses: BundleEvent["status"][] = [];
  const blockStatuses: BlockEvent["status"][] = [];

  ffca.on("mutation", (e) => mutationStatuses.push(e.status));
  ffca.on("bundle", (e) => bundleStatuses.push(e.status));
  ffca.on("block", (e) => blockStatuses.push(e.status));

  const waitFor = async (predicate: () => boolean, message: string) => {
    const deadline = Date.now() + 5000;
    while (predicate() === false) {
      if (Date.now() > deadline) {
        throw new Error(message);
      }
      await new Promise((r) => setTimeout(r, 50));
    }
  };

  await ffca.execute({
    name: "add",
    args: { amount: 7n, nonce: 0n },
    signature: signCounter({
      privateKey: USER_PRIVATE_KEY,
      amount: 7n,
      nonce: 0n,
      address,
      chainId: anvil.id,
    }),
  });

  await waitFor(
    () => mutationStatuses.includes("included"),
    "included event never arrived",
  );

  await TEST_CLIENT.mine({ blocks: 1 });
  await waitFor(
    () => mutationStatuses.includes("safe"),
    "safe event never arrived",
  );

  await TEST_CLIENT.mine({ blocks: 2 });
  await waitFor(
    () => mutationStatuses.includes("finalized"),
    "finalized event never arrived",
  );

  expect(mutationStatuses).toEqual([
    "submitted",
    "accepted",
    "included",
    "safe",
    "finalized",
  ]);
  expect(bundleStatuses).toEqual(["accepted", "included", "safe", "finalized"]);
  expect(blockStatuses).toEqual(["included", "safe", "finalized"]);

  await ffca.stop();
});
