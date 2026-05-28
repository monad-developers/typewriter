import { expect, test } from "bun:test";
import { anvil } from "viem/chains";
import {
  SCHEDULER_ACCOUNT,
  TEST_CLIENT,
  TEST_DB_URL,
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
  signCounter,
} from "../test/utils";
import { createFFCA, type FFCAConfig, type FFCAMutation } from "./index";

function counterAddMutation(params: {
  readonly address: `0x${string}`;
  readonly amount: bigint;
  readonly nonce: bigint;
}): FFCAMutation {
  return {
    name: "add",
    args: { amount: params.amount, nonce: params.nonce },
    signature: signCounter({
      privateKey: USER_PRIVATE_KEY,
      amount: params.amount,
      nonce: params.nonce,
      address: params.address,
      chainId: anvil.id,
    }),
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function observeSettlement<T>(
  promise: Promise<T>,
  timeoutMs: number,
): Promise<
  | { readonly status: "resolved" }
  | { readonly status: "rejected"; readonly error: unknown }
  | { readonly status: "timed-out" }
> {
  return Promise.race([
    promise.then(
      () => ({ status: "resolved" }) as const,
      (error) => ({ status: "rejected", error }) as const,
    ),
    sleep(timeoutMs).then(() => ({ status: "timed-out" }) as const),
  ]);
}

test("createFFCA stops accepting mutations after submit nonce mismatch", async () => {
  const address = await deployCounter(USER_ACCOUNT.address);
  const fatalErrors: unknown[] = [];
  const config = {
    address,
    domain: COUNTER_DOMAIN,
    abi: COUNTER_ABI,
    storageLayout: COUNTER_STORAGE_LAYOUT,
    account: SCHEDULER_ACCOUNT,
    chainId: anvil.id,
    rpcUrl: TEST_RPC_URL,
    sequencing: {
      order: "batch",
      batchOrder: ["add"],
      batchIntervalMs: 250,
      submitIntervalMs: 25,
    },
    database: { url: TEST_DB_URL, maxConnections: 2 },
    blockPollingIntervalMs: 50,
    onFatalError: (error) => {
      fatalErrors.push(error);
    },
    mutations: COUNTER_MUTATIONS,
  } as const satisfies FFCAConfig;

  const ffca = await createFFCA(config);
  await TEST_WALLET_CLIENT.sendTransaction({
    account: SCHEDULER_ACCOUNT,
    chain: anvil,
    to: USER_ACCOUNT.address,
    value: 1n,
  });
  await TEST_CLIENT.mine({ blocks: 1 });

  await ffca.execute(counterAddMutation({ address, amount: 7n, nonce: 0n }));

  const pendingResult = await observeSettlement(
    ffca.execute(counterAddMutation({ address, amount: 8n, nonce: 1n })),
    1_000,
  );

  expect(pendingResult.status).toBe("rejected");

  const futureResult = await observeSettlement(
    ffca.execute(counterAddMutation({ address, amount: 9n, nonce: 2n })),
    1_000,
  );

  expect(futureResult.status).toBe("rejected");
  expect(fatalErrors).toHaveLength(1);
});
