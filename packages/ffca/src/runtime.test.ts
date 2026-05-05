import { expect, test } from "bun:test";
import { parseAbiParameters } from "abitype";
import type { TypedData } from "ox";
import { anvil } from "viem/chains";
import {
  SCHEDULER_ACCOUNT,
  TEST_PUBLIC_CLIENT,
  TEST_RPC_URL,
} from "../test/setup";
import {
  COUNTER_MUTATIONS,
  type CounterState,
  deployCounter,
  deployHarness,
  HARNESS_MUTATIONS,
  type HarnessState,
} from "../test/utils";
import { createFFCA, verifyMutation } from "./runtime";
import type { BlockEvent, BundleEvent, MutationEvent } from "./types";

const domain: TypedData.Domain = {
  name: "ffca-test",
  version: "1",
  chainId: 1,
  verifyingContract: "0x0000000000000000000000000000000000000001",
};

test("verifyMutation accepts a well-formed mutation", () => {
  expect(() =>
    verifyMutation(
      HARNESS_MUTATIONS.credit,
      {
        name: "credit",
        args: {
          account: "0x0000000000000000000000000000000000000001",
          amount: 5n,
        },
        signature: "0x",
      },
      domain,
    ),
  ).not.toThrow();
});

test("verifyMutation throws when args is not an object", () => {
  expect(() =>
    verifyMutation(
      HARNESS_MUTATIONS.credit,
      { name: "credit", args: null, signature: "0x" },
      domain,
    ),
  ).toThrow(/args must be an object/);
  expect(() =>
    verifyMutation(
      HARNESS_MUTATIONS.credit,
      { name: "credit", args: "string", signature: "0x" },
      domain,
    ),
  ).toThrow(/args must be an object/);
});

test("verifyMutation throws on missing required field", () => {
  expect(() =>
    verifyMutation(
      HARNESS_MUTATIONS.credit,
      {
        name: "credit",
        args: { account: "0x0000000000000000000000000000000000000001" },
        signature: "0x",
      },
      domain,
    ),
  ).toThrow(/missing field: amount/);
});

test("verifyMutation throws on invalid address", () => {
  expect(() =>
    verifyMutation(
      HARNESS_MUTATIONS.credit,
      {
        name: "credit",
        args: { account: "not-an-address", amount: 5n },
        signature: "0x",
      },
      domain,
    ),
  ).toThrow(/Address.*invalid/);
});

test("verifyMutation throws on uint overflow", () => {
  expect(() =>
    verifyMutation(
      HARNESS_MUTATIONS.credit,
      {
        name: "credit",
        args: {
          account: "0x0000000000000000000000000000000000000001",
          amount: 2n ** 256n,
        },
        signature: "0x",
      },
      domain,
    ),
  ).toThrow(/safe 256-bit unsigned integer range/);
});

test("ffca.domain is derived from config", async () => {
  const ffca = createFFCA({
    address: "0x000000000000000000000000000000000000abcd",
    abi: [],
    // biome-ignore lint/suspicious/noExplicitAny: stub field, types not the focus
    account: {} as any,
    chainId: 1,
    rpcUrl: "http://localhost:8545",
    domain: { name: "my-app", version: "2" },
    state: { initial: {} },
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

test("bundle applies mutations in config.sequence order within a bundle", async () => {
  const applied: string[] = [];
  const noop = parseAbiParameters("uint256 nonce");
  const ffca = createFFCA({
    address: "0x0000000000000000000000000000000000000000",
    abi: [],
    // biome-ignore lint/suspicious/noExplicitAny: stub field
    account: {} as any,
    chainId: 1,
    rpcUrl: "http://localhost:8545",
    domain: { name: "ffca-test", version: "1" },
    state: { initial: {} },
    sequence: ["cancel", "limit", "market"],
    mutations: {
      cancel: {
        tag: 0,
        params: noop,
        apply: () => {
          applied.push("cancel");
        },
      },
      limit: {
        tag: 1,
        params: noop,
        apply: () => {
          applied.push("limit");
        },
      },
      market: {
        tag: 2,
        params: noop,
        apply: () => {
          applied.push("market");
        },
      },
    },
  });

  // Submit out of order; queue together so they land in the same bundle.
  await Promise.all([
    ffca.execute({ name: "market", args: { nonce: 1n }, signature: "0x" }),
    ffca.execute({ name: "cancel", args: { nonce: 2n }, signature: "0x" }),
    ffca.execute({ name: "limit", args: { nonce: 3n }, signature: "0x" }),
    ffca.execute({ name: "limit", args: { nonce: 4n }, signature: "0x" }),
    ffca.execute({ name: "cancel", args: { nonce: 5n }, signature: "0x" }),
  ]);

  expect(applied).toEqual(["cancel", "cancel", "limit", "limit", "market"]);

  await ffca.stop();
});

test("execute rejects mutations whose name isn't in sequence", async () => {
  const ffca = createFFCA({
    address: "0x0000000000000000000000000000000000000000",
    abi: [],
    // biome-ignore lint/suspicious/noExplicitAny: stub field, types not the focus
    account: {} as any,
    chainId: 1,
    rpcUrl: "http://localhost:8545",
    domain: { name: "ffca-test", version: "1" },
    state: { initial: {} },
    mutations: { credit: HARNESS_MUTATIONS.credit },
    sequence: ["other"],
  });

  await expect(
    ffca.execute({
      name: "credit",
      args: {
        account: "0x0000000000000000000000000000000000000001",
        amount: 5n,
      },
      signature: "0x",
    }),
  ).rejects.toThrow(/mutation not in sequence: credit/);

  await ffca.stop();
});

// Counter: a single mutation lands on chain with the right value.
test("e2e Counter: single mutation", async () => {
  const { address, abi } = await deployCounter();

  const ffca = createFFCA({
    address,
    domain: { name: "ffca-test", version: "1" },
    abi,
    account: SCHEDULER_ACCOUNT,
    chainId: anvil.id,
    rpcUrl: TEST_RPC_URL,
    state: { initial: { total: 0n } as CounterState },
    mutations: COUNTER_MUTATIONS,
  });

  await ffca.execute({ name: "add", args: { amount: 7n }, signature: "0x" });

  const readTotal = () =>
    TEST_PUBLIC_CLIENT.readContract({
      abi,
      address,
      functionName: "state",
    }) as Promise<bigint>;
  const deadline = Date.now() + 5000;
  while ((await readTotal()) === 0n) {
    if (Date.now() > deadline) throw new Error("mutation never landed onchain");
    await new Promise((r) => setTimeout(r, 50));
  }

  expect(await readTotal()).toBe(7n);
  expect((ffca.state as CounterState).total).toBe(7n);

  await ffca.stop();
});

// Counter: multiple mutations in one bundle each contribute to onchain state.
// Catches any bug where bundle encoding loses or aliases per-mutation data.
test("e2e Counter: multiple mutations in one bundle", async () => {
  const { address, abi } = await deployCounter();

  const ffca = createFFCA({
    address,
    domain: { name: "ffca-test", version: "1" },
    abi,
    account: SCHEDULER_ACCOUNT,
    chainId: anvil.id,
    rpcUrl: TEST_RPC_URL,
    state: { initial: { total: 0n } as CounterState },
    mutations: COUNTER_MUTATIONS,
  });

  await Promise.all([
    ffca.execute({ name: "add", args: { amount: 5n }, signature: "0x" }),
    ffca.execute({ name: "add", args: { amount: 7n }, signature: "0x" }),
    ffca.execute({ name: "add", args: { amount: 11n }, signature: "0x" }),
  ]);

  const readTotal = () =>
    TEST_PUBLIC_CLIENT.readContract({
      abi,
      address,
      functionName: "state",
    }) as Promise<bigint>;
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
// accepts the resolution. Exercises the resolve → encode → onchain verify path.
test("e2e Harness: mutation with resolution", async () => {
  const { address, abi } = await deployHarness();
  const alice = "0x00000000000000000000000000000000000a11ce" as const;

  const ffca = createFFCA({
    address,
    domain: { name: "ffca-test", version: "1" },
    abi,
    account: SCHEDULER_ACCOUNT,
    chainId: anvil.id,
    rpcUrl: TEST_RPC_URL,
    state: { initial: { balances: {} } as HarnessState },
    mutations: {
      credit: HARNESS_MUTATIONS.credit,
      debit: HARNESS_MUTATIONS.debit,
    },
  });

  // Submit in dependency order; no `sequence` needed.
  await ffca.execute({
    name: "credit",
    args: { account: alice, amount: 100n },
    signature: "0x",
  });
  await ffca.execute({
    name: "debit",
    args: { account: alice, amount: 30n },
    signature: "0x",
  });

  const readBalance = () =>
    TEST_PUBLIC_CLIENT.readContract({
      abi,
      address,
      functionName: "balances",
      args: [alice],
    }) as Promise<bigint>;
  const deadline = Date.now() + 5000;
  while ((await readBalance()) !== 70n) {
    if (Date.now() > deadline) {
      throw new Error(`balance never reached 70; saw ${await readBalance()}`);
    }
    await new Promise((r) => setTimeout(r, 50));
  }

  expect(await readBalance()).toBe(70n);
  expect((ffca.state as HarnessState).balances[alice]).toBe(70n);

  await ffca.stop();
});

// Harness: when mutations arrive out of order, `sequence` sorts them so the
// debit's resolve runs against post-credit state. If sort were broken, debit's
// resolve would underflow and the bundle would never encode.
test("e2e Harness: mutations reorded by sequence", async () => {
  const { address, abi } = await deployHarness();
  const alice = "0x00000000000000000000000000000000000a11ce" as const;

  const ffca = createFFCA({
    address,
    domain: { name: "ffca-test", version: "1" },
    abi,
    account: SCHEDULER_ACCOUNT,
    chainId: anvil.id,
    rpcUrl: TEST_RPC_URL,
    state: { initial: { balances: {} } as HarnessState },
    sequence: ["credit", "debit"],
    mutations: {
      credit: HARNESS_MUTATIONS.credit,
      debit: HARNESS_MUTATIONS.debit,
    },
  });

  // Submit debit before credit — sequence must sort credit first.
  await Promise.all([
    ffca.execute({
      name: "debit",
      args: { account: alice, amount: 30n },
      signature: "0x",
    }),
    ffca.execute({
      name: "credit",
      args: { account: alice, amount: 100n },
      signature: "0x",
    }),
  ]);

  const readBalance = () =>
    TEST_PUBLIC_CLIENT.readContract({
      abi,
      address,
      functionName: "balances",
      args: [alice],
    }) as Promise<bigint>;
  const deadline = Date.now() + 5000;
  while ((await readBalance()) !== 70n) {
    if (Date.now() > deadline) {
      throw new Error(`balance never reached 70; saw ${await readBalance()}`);
    }
    await new Promise((r) => setTimeout(r, 50));
  }

  expect(await readBalance()).toBe(70n);
  expect((ffca.state as HarnessState).balances[alice]).toBe(70n);

  await ffca.stop();
});

// Harness: an apply that throws (debit against zero balance) rejects that
// mutation's execute() promise without crashing the runtime; sibling mutations
// in the same bundle still land, and a follow-up mutation works.
test("e2e Harness: apply error rejects without crashing", async () => {
  const { address, abi } = await deployHarness();
  const alice = "0x00000000000000000000000000000000000a11ce" as const;
  const bob = "0x0000000000000000000000000000000000000b0b" as const;

  const ffca = createFFCA({
    address,
    domain: { name: "ffca-test", version: "1" },
    abi,
    account: SCHEDULER_ACCOUNT,
    chainId: anvil.id,
    rpcUrl: TEST_RPC_URL,
    state: { initial: { balances: {} } as HarnessState },
    sequence: ["credit", "debit"],
    mutations: {
      credit: HARNESS_MUTATIONS.credit,
      debit: HARNESS_MUTATIONS.debit,
    },
  });

  const readBalance = (account: string) =>
    TEST_PUBLIC_CLIENT.readContract({
      abi,
      address,
      functionName: "balances",
      args: [account],
    }) as Promise<bigint>;

  await Promise.all([
    expect(
      ffca.execute({
        name: "debit",
        args: { account: alice, amount: 30n },
        signature: "0x",
      }),
    ).rejects.toThrow(/insufficient balance/),
    ffca.execute({
      name: "credit",
      args: { account: bob, amount: 50n },
      signature: "0x",
    }),
  ]);

  const deadline = Date.now() + 5000;
  while ((await readBalance(bob)) === 0n) {
    if (Date.now() > deadline) {
      throw new Error("credit never landed onchain");
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  expect(await readBalance(bob)).toBe(50n);
  expect(await readBalance(alice)).toBe(0n);

  // Runtime survived: a follow-up mutation lands.
  await ffca.execute({
    name: "credit",
    args: { account: bob, amount: 7n },
    signature: "0x",
  });
  while ((await readBalance(bob)) === 50n) {
    if (Date.now() > deadline) {
      throw new Error("follow-up credit never landed");
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  expect(await readBalance(bob)).toBe(57n);

  await ffca.stop();
});

// Fan-out: a single happy-path mutation produces the full lifecycle of events
// to subscribers — pending/accepted/proposed for the mutation, accepted/proposed
// for its bundle and block. Off-then-on confirms unsubscribe works.
test("e2e Counter: subscribers receive lifecycle events", async () => {
  const { address, abi } = await deployCounter();

  const ffca = createFFCA({
    address,
    domain: { name: "ffca-test", version: "1" },
    abi,
    account: SCHEDULER_ACCOUNT,
    chainId: anvil.id,
    rpcUrl: TEST_RPC_URL,
    state: { initial: { total: 0n } as CounterState },
    mutations: COUNTER_MUTATIONS,
  });

  const mutationEvents: MutationEvent[] = [];
  const bundleEvents: BundleEvent[] = [];
  const blockEvents: BlockEvent[] = [];

  const offMutation = ffca.on("mutation", (e) => mutationEvents.push(e));
  ffca.on("bundle", (e) => bundleEvents.push(e));
  ffca.on("block", (e) => blockEvents.push(e));

  await ffca.execute({ name: "add", args: { amount: 7n }, signature: "0x" });

  // Wait for the proposed events (submit cycle adds ~400ms after accept).
  const deadline = Date.now() + 5000;
  while (
    !mutationEvents.some((e) => e.status === "proposed") ||
    !blockEvents.some((e) => e.status === "proposed")
  ) {
    if (Date.now() > deadline) {
      throw new Error("proposed events never arrived");
    }
    await new Promise((r) => setTimeout(r, 50));
  }

  expect(mutationEvents.map((e) => e.status)).toEqual([
    "pending",
    "accepted",
    "proposed",
  ]);
  expect(bundleEvents.map((e) => e.status)).toEqual(["accepted", "proposed"]);
  expect(blockEvents.map((e) => e.status)).toEqual(["accepted", "proposed"]);

  // The disposer returned by on() unsubscribes that listener.
  offMutation();
  await ffca.execute({ name: "add", args: { amount: 3n }, signature: "0x" });
  while (bundleEvents.length < 4) {
    if (Date.now() > deadline) {
      throw new Error("second bundle's proposed event never arrived");
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  // Same three statuses as before — no new mutation events after unsubscribe.
  expect(mutationEvents.map((e) => e.status)).toEqual([
    "pending",
    "accepted",
    "proposed",
  ]);

  await ffca.stop();
});
