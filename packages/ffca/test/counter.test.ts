import { beforeEach, expect, test } from "bun:test";
import {
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  http,
} from "viem";
import { anvil } from "viem/chains";
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
const walletClient = createWalletClient({
  chain: anvil,
  account: schedulerAccount,
  transport: http(rpcUrl),
});

const readBundleCount = () =>
  publicClient.readContract({
    abi: counterAbi,
    address: counterAddress,
    functionName: "bundleCount",
  }) as Promise<bigint>;

async function callExecute(bundles: { mutations: number[] }[]) {
  const data = encodeFunctionData({
    abi: counterAbi,
    functionName: "execute",
    args: [
      bundles.map((b) => ({
        mutations: b.mutations,
        mutationData: b.mutations.map(() => "0x" as const),
        signatures: b.mutations.map(() => "0x" as const),
      })),
    ],
  });
  const hash = await walletClient.sendTransaction({
    to: counterAddress,
    data,
  });
  await publicClient.waitForTransactionReceipt({ hash });
}

test("counter is fresh at the start of each test", async () => {
  expect(await readBundleCount()).toBe(0n);
});

test("execute() bumps the counter", async () => {
  await callExecute([{ mutations: [0, 1] }]);
  expect(await readBundleCount()).toBe(1n);
});

test("snapshot revert resets the counter for the next test", async () => {
  // Counter should be back to 0 even though the previous test bumped it.
  expect(await readBundleCount()).toBe(0n);
});
