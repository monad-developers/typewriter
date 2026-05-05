import { beforeEach, expect, test } from "bun:test";
import { parseAbiParameters } from "abitype";
import { createPublicClient, http } from "viem";
import { anvil } from "viem/chains";
import type { FFCAConfig } from "../src/config";
import { createFFCA } from "../src/runtime";
import {
  counterAbi,
  counterAddress,
  resetChain,
  rpcUrl,
  schedulerAccount,
} from "./setup";

beforeEach(resetChain);

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

// Wait until `predicate()` returns truthy or `timeoutMs` elapses. Polls every
// `intervalMs`. Throws on timeout. Used to wait for the submit cycle to fire.
async function waitFor<T>(
  predicate: () => Promise<T>,
  timeoutMs = 5000,
  intervalMs = 50,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const result = await predicate();
    if (result) return result;
    if (Date.now() > deadline) {
      throw new Error(`waitFor timed out after ${timeoutMs}ms`);
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

test("submit lands a bundle on chain via Counter", async () => {
  const config: FFCAConfig = {
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
  };
  const ffca = createFFCA(config);

  // Submit three mutations; they should batch into a single bundle.
  await Promise.all([
    ffca.execute({ name: "noop", args: { nonce: 1n }, signature: "0x" }),
    ffca.execute({ name: "noop", args: { nonce: 2n }, signature: "0x" }),
    ffca.execute({ name: "noop", args: { nonce: 3n }, signature: "0x" }),
  ]);

  // Wait for the submit cycle (default SUBMIT_INTERVAL_MS = 400) to fire.
  await waitFor(async () => (await readBundleCount()) > 0n);

  expect(await readBundleCount()).toBe(1n);
  expect(await readMutationCount()).toBe(3n);

  await ffca.stop();
});
