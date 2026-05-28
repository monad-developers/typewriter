import { test } from "bun:test";
import { anvil } from "viem/chains";
import { createFFCA, type FFCAConfig, type FFCAMutation } from "../src";
import {
  SCHEDULER_ACCOUNT,
  TEST_DB_URL,
  TEST_RPC_URL,
  USER_ACCOUNT,
  USER_PRIVATE_KEY,
} from "./setup";
import {
  COUNTER_ABI,
  COUNTER_DOMAIN,
  COUNTER_MUTATIONS,
  COUNTER_STORAGE_LAYOUT,
  counterNewAccountMutation,
  deployCounter,
  signCounter,
} from "./utils";

const MUTATION_COUNT = 10_000;

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

function percentile(values: readonly number[], p: number): number {
  const index = Math.min(
    values.length - 1,
    Math.floor((values.length - 1) * p),
  );
  return values[index]!;
}

function formatMs(durationMs: number): string {
  return `${durationMs.toFixed(2)}ms`;
}

test(`counter accepts ${MUTATION_COUNT.toLocaleString()} mutations`, async () => {
  const address = await deployCounter(USER_ACCOUNT.address);
  const ffca = await createFFCA({
    address,
    domain: COUNTER_DOMAIN,
    abi: COUNTER_ABI,
    storageLayout: COUNTER_STORAGE_LAYOUT,
    account: SCHEDULER_ACCOUNT,
    chainId: anvil.id,
    rpcUrl: TEST_RPC_URL,
    sequencing: { order: "fifo", submitIntervalMs: 3_600_000 },
    database: { url: TEST_DB_URL, maxConnections: 2 },
    blockPollingIntervalMs: 3_600_000,
    mutations: COUNTER_MUTATIONS,
  } as const satisfies FFCAConfig);

  await ffca.execute(
    counterNewAccountMutation({ address: USER_ACCOUNT.address }),
  );

  const mutations = Array.from({ length: MUTATION_COUNT }, (_, index) =>
    counterAddMutation({
      address,
      amount: 1n,
      nonce: BigInt(index),
    }),
  );

  const mutationDurationsMs: number[] = [];
  const totalStart = performance.now();

  for (const mutation of mutations) {
    const mutationStart = performance.now();
    await ffca.execute(mutation);
    mutationDurationsMs.push(performance.now() - mutationStart);
  }

  const totalDurationMs = performance.now() - totalStart;
  const sortedDurationsMs = mutationDurationsMs.toSorted((a, b) => a - b);
  const averageDurationMs = totalDurationMs / MUTATION_COUNT;
  const mutationsPerSecond = MUTATION_COUNT / (totalDurationMs / 1_000);

  console.log(`
Counter benchmark
mutations: ${MUTATION_COUNT.toLocaleString()}
total: ${formatMs(totalDurationMs)}
average: ${formatMs(averageDurationMs)}
p50: ${formatMs(percentile(sortedDurationsMs, 0.5))}
p95: ${formatMs(percentile(sortedDurationsMs, 0.95))}
p99: ${formatMs(percentile(sortedDurationsMs, 0.99))}
throughput: ${mutationsPerSecond.toFixed(2)} mutations/s`);
}, 120_000);
