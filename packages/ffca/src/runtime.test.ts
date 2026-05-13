import { expect, test } from "bun:test";
import { parseAbiParameters } from "abitype";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sql";
import type { TypedData } from "ox";
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
  TEST_PUBLIC_CLIENT,
  TEST_RPC_URL,
  USER_ACCOUNT,
  USER_PRIVATE_KEY,
} from "../test/setup";
import {
  COUNTER_DOMAIN,
  COUNTER_MUTATIONS,
  COUNTER_SIGNATURE_PARAMS,
  type CounterState,
  deployCounter,
  deployHarness,
  HARNESS_DOMAIN,
  HARNESS_MUTATIONS,
  HARNESS_PERSISTED_MUTATIONS,
  HARNESS_SCHEMA,
  HARNESS_SIGNATURE_PARAMS,
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
  secp256k1PublicKey,
  setupHarnessAccount,
  signCounter,
  signHarness,
  testMutationSchema,
} from "../test/utils";
import { hashMutationEip712 } from "./eip712";
import { createFFCA, verifyMutation, verifyResolution } from "./runtime";
import type { BlockEvent, BundleEvent, MutationEvent } from "./types";

const domain: TypedData.Domain = {
  name: "ffca-test",
  version: "1",
  chainId: 1,
  verifyingContract: "0x0000000000000000000000000000000000000001",
};

const TEST_SIGNATURE = {
  params: parseAbiParameters("uint8 keyType, bytes rawSignature"),
};

// Small inline mutation for the shape-checking tests, kept independent of
// Harness/Counter so their evolving param lists don't drift these.
const SHAPE_MUTATION = {
  tag: 0,
  table: testMutationSchema,
  params: parseAbiParameters("address account, uint256 amount"),
  apply: () => {},
};

test("verifyMutation accepts a well-formed mutation", () => {
  expect(() =>
    verifyMutation(
      SHAPE_MUTATION,
      TEST_SIGNATURE.params,
      {
        name: "shape",
        args: {
          account: "0x0000000000000000000000000000000000000001",
          amount: 5n,
        },
        signature: { keyType: 0, rawSignature: "0x" },
      },
      domain,
    ),
  ).not.toThrow();
});

test("verifyMutation throws when args is not an object", () => {
  expect(() =>
    verifyMutation(
      SHAPE_MUTATION,
      TEST_SIGNATURE.params,
      {
        name: "shape",
        args: null,
        signature: { keyType: 0, rawSignature: "0x" },
      },
      domain,
    ),
  ).toThrow(/args must be an object/);
  expect(() =>
    verifyMutation(
      SHAPE_MUTATION,
      TEST_SIGNATURE.params,
      {
        name: "shape",
        args: "string",
        signature: { keyType: 0, rawSignature: "0x" },
      },
      domain,
    ),
  ).toThrow(/args must be an object/);
});

test("verifyMutation throws on missing required field", () => {
  expect(() =>
    verifyMutation(
      SHAPE_MUTATION,
      TEST_SIGNATURE.params,
      {
        name: "shape",
        args: { account: "0x0000000000000000000000000000000000000001" },
        signature: { keyType: 0, rawSignature: "0x" },
      },
      domain,
    ),
  ).toThrow(/missing field: amount/);
});

test("verifyMutation throws on invalid address", () => {
  expect(() =>
    verifyMutation(
      SHAPE_MUTATION,
      TEST_SIGNATURE.params,
      {
        name: "shape",
        args: { account: "not-an-address", amount: 5n },
        signature: { keyType: 0, rawSignature: "0x" },
      },
      domain,
    ),
  ).toThrow(/Address.*invalid/);
});

test("verifyMutation throws on uint overflow", () => {
  expect(() =>
    verifyMutation(
      SHAPE_MUTATION,
      TEST_SIGNATURE.params,
      {
        name: "shape",
        args: {
          account: "0x0000000000000000000000000000000000000001",
          amount: 2n ** 256n,
        },
        signature: { keyType: 0, rawSignature: "0x" },
      },
      domain,
    ),
  ).toThrow(/safe 256-bit unsigned integer range/);
});

test("verifyMutation throws on malformed signature", () => {
  expect(() =>
    verifyMutation(
      SHAPE_MUTATION,
      TEST_SIGNATURE.params,
      {
        name: "shape",
        args: {
          account: "0x0000000000000000000000000000000000000001",
          amount: 5n,
        },
        signature: { keyType: 0 },
      },
      domain,
    ),
  ).toThrow(/missing signature field: rawSignature/);
  expect(() =>
    verifyMutation(
      SHAPE_MUTATION,
      TEST_SIGNATURE.params,
      {
        name: "shape",
        args: {
          account: "0x0000000000000000000000000000000000000001",
          amount: 5n,
        },
        signature: { keyType: 256, rawSignature: "0x" },
      },
      domain,
    ),
  ).toThrow(/8-bit unsigned integer range/);
});

test("verifyResolution validates resolved shape", () => {
  const mutation = {
    tag: 0,
    table: testMutationSchema,
    params: parseAbiParameters("uint256 amount"),
    resolution: parseAbiParameters("uint256 newBalance"),
    resolve: () => ({ newBalance: 0n }),
    apply: () => {},
  };

  expect(() =>
    verifyResolution(mutation, { newBalance: 1n }, "shape"),
  ).not.toThrow();
  expect(() => verifyResolution(mutation, {}, "shape")).toThrow(
    /missing resolution field: newBalance/,
  );
  expect(() =>
    verifyResolution(mutation, { newBalance: -1n }, "shape"),
  ).toThrow(/safe 256-bit unsigned integer range/);
});

test("ffca.domain is derived from config", async () => {
  const ffca = await createFFCA({
    address: "0x000000000000000000000000000000000000abcd",
    abi: [],
    // biome-ignore lint/suspicious/noExplicitAny: stub field, types not the focus
    account: {} as any,
    chainId: 1,
    rpcUrl: "http://localhost:8545",
    domain: { name: "my-app", version: "2" },
    state: { initial: {} },
    signature: TEST_SIGNATURE,
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
      abi: [],
      // biome-ignore lint/suspicious/noExplicitAny: stub field, types not the focus
      account: {} as any,
      chainId: 1,
      rpcUrl: "http://localhost:8545",
      domain: { name: "my-app", version: "2" },
      state: { initial: {}, schema: HARNESS_SCHEMA },
      signature: TEST_SIGNATURE,
      mutations: { shape: SHAPE_MUTATION },
    }),
  ).rejects.toThrow(/persistence must be fully configured/);
});

test("createFFCA loads persisted state before returning", async () => {
  const initialState = { accounts: {}, balances: {}, loaded: false };
  const loadedState = { accounts: {}, balances: {}, loaded: true };
  const ffca = await createFFCA({
    address: "0x000000000000000000000000000000000000ffca",
    abi: [],
    // biome-ignore lint/suspicious/noExplicitAny: stub field, types not the focus
    account: {} as any,
    chainId: 31337,
    rpcUrl: TEST_RPC_URL,
    domain: HARNESS_DOMAIN,
    database: { connection: TEST_DB_CONNECTION },
    state: {
      initial: initialState,
      schema: HARNESS_SCHEMA,
      load: async () => loadedState,
    },
    signature: { params: HARNESS_SIGNATURE_PARAMS },
    mutations: { initialize: HARNESS_PERSISTED_MUTATIONS.initialize },
  });

  expect(initialState.loaded).toBe(false);
  expect(ffca.state).toBe(loadedState);

  await ffca.stop();
});

test("bundle applies mutations in config.sequence order within a bundle", async () => {
  const applied: string[] = [];
  const noop = parseAbiParameters("uint256 nonce");
  const ffca = await createFFCA({
    address: "0x0000000000000000000000000000000000000000",
    abi: [],
    // biome-ignore lint/suspicious/noExplicitAny: stub field
    account: {} as any,
    chainId: 1,
    rpcUrl: "http://localhost:8545",
    domain: { name: "ffca-test", version: "1" },
    state: { initial: {} },
    signature: TEST_SIGNATURE,
    sequence: ["cancel", "limit", "market"],
    mutations: {
      cancel: {
        tag: 0,
        table: testMutationSchema,
        params: noop,
        apply: () => {
          applied.push("cancel");
        },
      },
      limit: {
        tag: 1,
        table: testMutationSchema,
        params: noop,
        apply: () => {
          applied.push("limit");
        },
      },
      market: {
        tag: 2,
        table: testMutationSchema,
        params: noop,
        apply: () => {
          applied.push("market");
        },
      },
    },
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

test("execute rejects mutations whose name isn't in sequence", async () => {
  const ffca = await createFFCA({
    address: "0x0000000000000000000000000000000000000000",
    abi: [],
    // biome-ignore lint/suspicious/noExplicitAny: stub field, types not the focus
    account: {} as any,
    chainId: 1,
    rpcUrl: "http://localhost:8545",
    domain: { name: "ffca-test", version: "1" },
    state: { initial: {} },
    signature: TEST_SIGNATURE,
    mutations: { shape: SHAPE_MUTATION },
    sequence: ["other"],
  });

  await expect(
    ffca.execute({
      name: "shape",
      args: {
        account: "0x0000000000000000000000000000000000000001",
        amount: 5n,
      },
      signature: { keyType: 0, rawSignature: "0x" },
    }),
  ).rejects.toThrow(/mutation not in sequence: shape/);

  await ffca.stop();
});

test("resolve and apply receive submitted signature and apply receives digest", async () => {
  const signatures: unknown[] = [];
  const digests: unknown[] = [];
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
    apply: ({
      signature: submittedSignature,
      digest,
    }: {
      signature: unknown;
      digest: unknown;
    }) => {
      signatures.push(submittedSignature);
      digests.push(digest);
    },
  };
  const ffca = await createFFCA({
    address: "0x0000000000000000000000000000000000000000",
    abi: [],
    // biome-ignore lint/suspicious/noExplicitAny: stub field, types not the focus
    account: {} as any,
    chainId: 1,
    rpcUrl: "http://localhost:8545",
    domain: { name: "ffca-test", version: "1" },
    state: { initial: {} },
    signature: TEST_SIGNATURE,
    mutations: {
      shape: mutation,
    },
  });

  await ffca.execute({
    name: "shape",
    args: { amount: 5n },
    signature,
  });

  expect(signatures).toEqual([signature, signature]);
  expect(digests).toEqual([
    hashMutationEip712(mutation, "shape", { amount: 5n }, ffca.domain),
  ]);

  await ffca.stop();
});

test("Harness apply rejects invalid signatures using callback digest", async () => {
  const address = "0x0000000000000000000000000000000000000000";
  const state: HarnessState = { accounts: {}, balances: {} };
  const ffca = await createFFCA({
    address,
    domain: HARNESS_DOMAIN,
    abi: [],
    // biome-ignore lint/suspicious/noExplicitAny: no chain submission in this rejection test
    account: {} as any,
    chainId: 1,
    rpcUrl: TEST_RPC_URL,
    state: { initial: state },
    signature: { params: HARNESS_SIGNATURE_PARAMS },
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
          chainId: 1,
        }),
      },
    }),
  ).rejects.toThrow(/InvalidSignature: keyType=2/);

  expect(state.balances[account]).toBeUndefined();
  await ffca.stop();
});

// Counter: a single mutation, signed by the user, lands on chain.
// End-to-end through real EIP-712 signing and on-chain secp256k1 recovery.
test("e2e Counter: single mutation", async () => {
  const { address, abi } = await deployCounter(USER_ACCOUNT.address);

  const ffca = await createFFCA({
    address,
    domain: COUNTER_DOMAIN,
    abi,
    account: SCHEDULER_ACCOUNT,
    chainId: anvil.id,
    rpcUrl: TEST_RPC_URL,
    state: { initial: { total: 0n, nonce: 0n } as CounterState },
    signature: { params: COUNTER_SIGNATURE_PARAMS },
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
  expect((ffca.state as CounterState).total).toBe(7n);

  await ffca.stop();
});

// Counter: multiple signed mutations in one bundle each contribute to onchain
// state. Catches any bug where bundle encoding loses or aliases per-mutation
// data, and exercises the contract's nonce check across a bundle.
test("e2e Counter: multiple mutations in one bundle", async () => {
  const { address, abi } = await deployCounter(USER_ACCOUNT.address);

  const ffca = await createFFCA({
    address,
    domain: COUNTER_DOMAIN,
    abi,
    account: SCHEDULER_ACCOUNT,
    chainId: anvil.id,
    rpcUrl: TEST_RPC_URL,
    state: { initial: { total: 0n, nonce: 0n } as CounterState },
    signature: { params: COUNTER_SIGNATURE_PARAMS },
    mutations: COUNTER_MUTATIONS,
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
  expect((ffca.state as CounterState).total).toBe(23n);

  await ffca.stop();
});

// Harness: a debit's resolve runs against credited local state and the contract
// accepts the resolution. Exercises the resolve → encode → onchain verify path
// end-to-end through real EIP-712 signing + secp256k1 recovery.
test("e2e Harness: mutation with resolution", async () => {
  const { address, abi } = await deployHarness();

  const ffca = await createFFCA({
    address,
    domain: HARNESS_DOMAIN,
    abi,
    account: SCHEDULER_ACCOUNT,
    chainId: anvil.id,
    rpcUrl: TEST_RPC_URL,
    state: {
      initial: { accounts: {}, balances: {} } as HarnessState,
    },
    signature: { params: HARNESS_SIGNATURE_PARAMS },
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
  expect((ffca.state as HarnessState).balances[aliceId]).toBe(70n);

  await ffca.stop();
});

test("e2e Harness: persistence callbacks write accepted and proposed state", async () => {
  const { address, abi } = await deployHarness();

  const ffca = await createFFCA({
    address,
    domain: HARNESS_DOMAIN,
    abi,
    account: SCHEDULER_ACCOUNT,
    chainId: anvil.id,
    rpcUrl: TEST_RPC_URL,
    database: { connection: TEST_DB_CONNECTION },
    state: {
      initial: { accounts: {}, balances: {} } as HarnessState,
      schema: HARNESS_SCHEMA,
      load: loadHarnessState,
    },
    signature: { params: HARNESS_SIGNATURE_PARAMS },
    mutations: {
      initialize: HARNESS_PERSISTED_MUTATIONS.initialize,
      credit: HARNESS_PERSISTED_MUTATIONS.credit,
      debit: HARNESS_PERSISTED_MUTATIONS.debit,
    },
  });
  const db = drizzle(TEST_DB_CONNECTION, {
    schema: HARNESS_SCHEMA,
    casing: "snake_case",
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
  const waitForPersistedStatus = async (status: string) => {
    const statusDeadline = Date.now() + 5000;
    while (true) {
      const rows = await readPersistedMutations();
      if (
        rows.initialize?.status === status &&
        rows.credit?.status === status &&
        rows.debit?.status === status
      ) {
        return rows;
      }
      if (Date.now() > statusDeadline) {
        const rows = await readPersistedMutations();
        throw new Error(
          `mutations never reached ${status}; saw ${JSON.stringify({
            initialize: rows.initialize?.status,
            credit: rows.credit?.status,
            debit: rows.debit?.status,
          })}`,
        );
      }
      await new Promise((r) => setTimeout(r, 50));
    }
  };
  const { initialize, credit, debit } =
    await waitForPersistedStatus("proposed");

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
    status: "proposed",
    account: aliceId,
    rootKeyType: 2,
    rootPublicKey,
  });
  expect(credit).toMatchObject({
    id: 1,
    status: "proposed",
    account: aliceId,
    amount: "100",
    nonce: "0",
  });
  expect(debit).toMatchObject({
    id: 2,
    status: "proposed",
    account: aliceId,
    amount: "30",
    nonce: "1",
    newBalance: "70",
  });
  expect(credit?.blockNumber).not.toBeNull();
  expect(debit?.transactionHash).toMatch(/^0x/);

  await ffca.stop();
});

test("e2e Harness: authorize persistence writes per-mutation key rows", async () => {
  const { address, abi } = await deployHarness();

  const ffca = await createFFCA({
    address,
    domain: HARNESS_DOMAIN,
    abi,
    account: SCHEDULER_ACCOUNT,
    chainId: anvil.id,
    rpcUrl: TEST_RPC_URL,
    database: { connection: TEST_DB_CONNECTION },
    state: {
      initial: { accounts: {}, balances: {} } as HarnessState,
      schema: HARNESS_SCHEMA,
      load: loadHarnessState,
    },
    signature: { params: HARNESS_SIGNATURE_PARAMS },
    sequence: ["initialize", "authorize"],
    mutations: {
      initialize: HARNESS_PERSISTED_MUTATIONS.initialize,
      authorize: HARNESS_PERSISTED_MUTATIONS.authorize,
    },
  });
  const db = drizzle(TEST_DB_CONNECTION, {
    schema: HARNESS_SCHEMA,
    casing: "snake_case",
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
  const { address, abi } = await deployHarness();

  const ffca = await createFFCA({
    address,
    domain: HARNESS_DOMAIN,
    abi,
    account: SCHEDULER_ACCOUNT,
    chainId: anvil.id,
    rpcUrl: TEST_RPC_URL,
    state: {
      initial: { accounts: {}, balances: {} } as HarnessState,
    },
    signature: { params: HARNESS_SIGNATURE_PARAMS },
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
  expect((ffca.state as HarnessState).balances[aliceId]).toBe(70n);

  await ffca.stop();
});

// Harness: an apply that throws (debit against zero balance) rejects that
// mutation's execute() promise without crashing the runtime; sibling mutations
// in the same bundle still land, and a follow-up mutation works.
test("e2e Harness: apply error rejects without crashing", async () => {
  const { address, abi } = await deployHarness();

  const ffca = await createFFCA({
    address,
    domain: HARNESS_DOMAIN,
    abi,
    account: SCHEDULER_ACCOUNT,
    chainId: anvil.id,
    rpcUrl: TEST_RPC_URL,
    state: {
      initial: { accounts: {}, balances: {} } as HarnessState,
    },
    signature: { params: HARNESS_SIGNATURE_PARAMS },
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

  // Runtime survived: a follow-up mutation lands.
  await ffca.execute({
    name: "credit",
    args: { account: bobId, keyId: 0n, amount: 7n, nonce: 1n },
    signature: {
      account: bobId,
      keyId: 0n,
      keyType: 2,
      rawSignature: signHarness({
        privateKey: BOB_PRIVATE_KEY,
        keyType: 2,
        mutation: "credit",
        args: { account: bobId, keyId: 0n, amount: 7n, nonce: 1n },
        address,
        chainId: anvil.id,
      }),
    },
  });
  while ((await readBalance(bobId)) === 50n) {
    if (Date.now() > deadline) {
      throw new Error("follow-up credit never landed");
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  expect(await readBalance(bobId)).toBe(57n);

  await ffca.stop();
});

// Harness: an account initialized with a secp256k1 root key authorizes a
// second secp256k1 key, then a mutation signed by *the second key* lands on
// chain. Proves the multi-key registry path end-to-end: the contract picks
// the right key by keyId and dispatches verification correctly.
test("e2e Harness: secp256k1 authorize flow", async () => {
  const { address, abi } = await deployHarness();

  const ffca = await createFFCA({
    address,
    domain: HARNESS_DOMAIN,
    abi,
    account: SCHEDULER_ACCOUNT,
    chainId: anvil.id,
    rpcUrl: TEST_RPC_URL,
    state: {
      initial: { accounts: {}, balances: {} } as HarnessState,
    },
    signature: { params: HARNESS_SIGNATURE_PARAMS },
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
  const { address, abi } = await deployHarness();

  const ffca = await createFFCA({
    address,
    domain: HARNESS_DOMAIN,
    abi,
    account: SCHEDULER_ACCOUNT,
    chainId: anvil.id,
    rpcUrl: TEST_RPC_URL,
    state: {
      initial: { accounts: {}, balances: {} } as HarnessState,
    },
    signature: { params: HARNESS_SIGNATURE_PARAMS },
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
  const { address, abi } = await deployHarness();

  const ffca = await createFFCA({
    address,
    domain: HARNESS_DOMAIN,
    abi,
    account: SCHEDULER_ACCOUNT,
    chainId: anvil.id,
    rpcUrl: TEST_RPC_URL,
    state: {
      initial: { accounts: {}, balances: {} } as HarnessState,
    },
    signature: { params: HARNESS_SIGNATURE_PARAMS },
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
// to subscribers — pending/accepted/proposed for the mutation, accepted/proposed
// for its bundle and block. Off-then-on confirms unsubscribe works.
test("e2e Counter: subscribers receive lifecycle events", async () => {
  const { address, abi } = await deployCounter(USER_ACCOUNT.address);

  const ffca = await createFFCA({
    address,
    domain: COUNTER_DOMAIN,
    abi,
    account: SCHEDULER_ACCOUNT,
    chainId: anvil.id,
    rpcUrl: TEST_RPC_URL,
    state: { initial: { total: 0n, nonce: 0n } as CounterState },
    signature: { params: COUNTER_SIGNATURE_PARAMS },
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

  // Wait for the proposed events (submit cycle adds ~400ms after accept).
  const deadline = Date.now() + 5000;
  while (
    !mutationStatuses.includes("proposed") ||
    !blockStatuses.includes("proposed")
  ) {
    if (Date.now() > deadline) {
      throw new Error("proposed events never arrived");
    }
    await new Promise((r) => setTimeout(r, 50));
  }

  expect(mutationStatuses).toEqual(["pending", "accepted", "proposed"]);
  expect(bundleStatuses).toEqual(["accepted", "proposed"]);
  expect(blockStatuses).toEqual(["accepted", "proposed"]);

  // The disposer returned by on() unsubscribes that listener.
  offMutation();
  await ffca.execute({
    name: "add",
    args: { amount: 3n, nonce: 1n },
    signature: sign({ amount: 3n, nonce: 1n }),
  });
  while (bundleStatuses.length < 4) {
    if (Date.now() > deadline) {
      throw new Error("second bundle's proposed event never arrived");
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  // Same three statuses as before — no new mutation events after unsubscribe.
  expect(mutationStatuses).toEqual(["pending", "accepted", "proposed"]);

  await ffca.stop();
});

test("e2e Counter: watch advances proposed bundles by confirmations", async () => {
  const { address, abi } = await deployCounter(USER_ACCOUNT.address);

  const ffca = await createFFCA({
    address,
    domain: COUNTER_DOMAIN,
    abi,
    account: SCHEDULER_ACCOUNT,
    chainId: anvil.id,
    rpcUrl: TEST_RPC_URL,
    state: { initial: { total: 0n, nonce: 0n } as CounterState },
    signature: { params: COUNTER_SIGNATURE_PARAMS },
    mutations: COUNTER_MUTATIONS,
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
    () => mutationStatuses.includes("proposed"),
    "proposed event never arrived",
  );

  await TEST_CLIENT.mine({ blocks: 1 });
  await waitFor(
    () => mutationStatuses.includes("voted"),
    "voted event never arrived",
  );

  await TEST_CLIENT.mine({ blocks: 1 });
  await waitFor(
    () => mutationStatuses.includes("finalized"),
    "finalized event never arrived",
  );

  await TEST_CLIENT.mine({ blocks: 3 });
  await waitFor(
    () => mutationStatuses.includes("verified"),
    "verified event never arrived",
  );

  expect(mutationStatuses).toEqual([
    "pending",
    "accepted",
    "proposed",
    "voted",
    "finalized",
    "verified",
  ]);
  expect(bundleStatuses).toEqual([
    "accepted",
    "proposed",
    "voted",
    "finalized",
    "verified",
  ]);
  expect(blockStatuses).toEqual([
    "accepted",
    "proposed",
    "voted",
    "finalized",
    "verified",
  ]);

  await ffca.stop();
});
