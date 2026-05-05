import { expect, test } from "bun:test";
import { parseAbiParameters } from "abitype";
import type { TypedData } from "ox";
import { createPublicClient, http } from "viem";
import { anvil } from "viem/chains";
import {
  counterAbi,
  counterAddress,
  resetChain,
  rpcUrl,
  schedulerAccount,
} from "../test/setup";
import type { FFCAConfig } from "./config";
import { createFFCA, verifyMutation } from "./runtime";
import type { SubmittedMutation } from "./types";

const domain: TypedData.Domain = {
  name: "ffca-test",
  version: "1",
  chainId: 1,
  verifyingContract: "0x0000000000000000000000000000000000000001",
};

const transferConfig = {
  address: "0x0000000000000000000000000000000000000000",
  abi: [],
  // biome-ignore lint/suspicious/noExplicitAny: stub field, types not the focus
  account: {} as any,
  chainId: 1,
  rpcUrl: "http://localhost:8545",
  domain: { name: "ffca-test", version: "1" },
  state: { initial: {} },
  mutations: {
    transfer: {
      tag: 0,
      params: parseAbiParameters("address from, address to, uint256 amount"),
      apply: () => {},
    },
  },
} satisfies FFCAConfig;

const transferMutation = transferConfig.mutations.transfer;

const submit = (args: unknown): SubmittedMutation => ({
  name: "transfer",
  args,
  signature: "0x",
});

test("verifyMutation accepts a well-formed mutation", () => {
  expect(() =>
    verifyMutation(
      transferMutation,
      submit({
        from: "0x0000000000000000000000000000000000000001",
        to: "0x0000000000000000000000000000000000000002",
        amount: 5n,
      }),
      domain,
    ),
  ).not.toThrow();
});

test("verifyMutation throws when args is not an object", () => {
  expect(() => verifyMutation(transferMutation, submit(null), domain)).toThrow(
    /args must be an object/,
  );
  expect(() =>
    verifyMutation(transferMutation, submit("string"), domain),
  ).toThrow(/args must be an object/);
});

test("verifyMutation throws on missing required field", () => {
  expect(() =>
    verifyMutation(
      transferMutation,
      submit({
        from: "0x0000000000000000000000000000000000000001",
        to: "0x0000000000000000000000000000000000000002",
        // missing amount
      }),
      domain,
    ),
  ).toThrow(/missing field: amount/);
});

test("verifyMutation throws on invalid address", () => {
  expect(() =>
    verifyMutation(
      transferMutation,
      submit({
        from: "not-an-address",
        to: "0x0000000000000000000000000000000000000002",
        amount: 5n,
      }),
      domain,
    ),
  ).toThrow(/Address.*invalid/);
});

test("verifyMutation throws on uint overflow", () => {
  expect(() =>
    verifyMutation(
      transferMutation,
      submit({
        from: "0x0000000000000000000000000000000000000001",
        to: "0x0000000000000000000000000000000000000002",
        amount: 2n ** 256n,
      }),
      domain,
    ),
  ).toThrow(/safe 256-bit unsigned integer range/);
});

test("ffca.domain is derived from config", async () => {
  const ffca = createFFCA({
    ...transferConfig,
    address: "0x000000000000000000000000000000000000abcd",
    chainId: 137,
    domain: { name: "my-app", version: "2" },
  });

  expect(ffca.domain).toEqual({
    name: "my-app",
    version: "2",
    chainId: 137,
    verifyingContract: "0x000000000000000000000000000000000000abcd",
  });

  await ffca.stop();
});

test("execute applies mutations in config.sequence order within a bundle", async () => {
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

  const sub = (name: string, nonce: bigint): SubmittedMutation => ({
    name,
    args: { nonce },
    signature: "0x",
  });

  // Submit out of order; queue together so they land in the same bundle.
  await Promise.all([
    ffca.execute(sub("market", 1n)),
    ffca.execute(sub("cancel", 2n)),
    ffca.execute(sub("limit", 3n)),
    ffca.execute(sub("limit", 4n)),
    ffca.execute(sub("cancel", 5n)),
  ]);

  // cancels first (insertion order), then limits (insertion order), then market.
  expect(applied).toEqual(["cancel", "cancel", "limit", "limit", "market"]);

  await ffca.stop();
});

test("execute rejects mutations whose name isn't in sequence", async () => {
  const ffca = createFFCA({
    ...transferConfig,
    sequence: ["other"],
  });

  await expect(
    ffca.execute({
      name: "transfer",
      args: {
        from: "0x0000000000000000000000000000000000000001",
        to: "0x0000000000000000000000000000000000000002",
        amount: 5n,
      },
      signature: "0x",
    }),
  ).rejects.toThrow(/mutation not in sequence: transfer/);

  await ffca.stop();
});

// End-to-end submit against a real chain. Uses the Counter test fixture from
// ../test/setup; see that file for the anvil + Counter deployment.
test("submit lands a bundle on chain via Counter", async () => {
  await resetChain();

  const publicClient = createPublicClient({
    chain: anvil,
    transport: http(rpcUrl),
  });
  const readBundleCount = () =>
    publicClient.readContract({
      abi: counterAbi,
      address: counterAddress,
      functionName: "bundleCount",
    }) as Promise<bigint>;
  const readMutationCount = () =>
    publicClient.readContract({
      abi: counterAbi,
      address: counterAddress,
      functionName: "mutationCount",
    }) as Promise<bigint>;

  const ffca = createFFCA({
    address: counterAddress,
    domain: { name: "ffca-test", version: "1" },
    abi: counterAbi,
    account: schedulerAccount,
    chainId: anvil.id,
    rpcUrl,
    state: { initial: {} },
    mutations: {
      noop: {
        tag: 0,
        params: parseAbiParameters("uint256 nonce"),
        apply: () => {},
      },
    },
  });

  // Three mutations submitted concurrently should batch into one bundle.
  await Promise.all([
    ffca.execute({ name: "noop", args: { nonce: 1n }, signature: "0x" }),
    ffca.execute({ name: "noop", args: { nonce: 2n }, signature: "0x" }),
    ffca.execute({ name: "noop", args: { nonce: 3n }, signature: "0x" }),
  ]);

  // Wait for the submit cycle (default 400ms) to land the bundle on chain.
  const deadline = Date.now() + 5000;
  while ((await readBundleCount()) === 0n) {
    if (Date.now() > deadline) throw new Error("bundle never landed onchain");
    await new Promise((r) => setTimeout(r, 50));
  }

  expect(await readBundleCount()).toBe(1n);
  expect(await readMutationCount()).toBe(3n);

  await ffca.stop();
});
