import { test } from "bun:test";
import { anvil } from "viem/chains";
import type { TypewriterConfig } from "../src";
import Harness from "./contracts/src/Harness.sol";
import {
  SCHEDULER_ACCOUNT,
  TEST_DB_URL,
  TEST_RPC_URL,
  USER_ACCOUNT,
  USER_PRIVATE_KEY,
} from "./setup";
import {
  deployHarness,
  nativeAccountID,
  prepareHarnessCreateAccount,
  prepareHarnessMutation,
  secp256k1PublicKey,
} from "./utils";

process.env.NODE_ENV = "production";

const MUTATION_COUNT = 10_000;

function harnessCreditMutation(params: {
  readonly address: `0x${string}`;
  readonly account: `0x${string}`;
  readonly amount: bigint;
  readonly nonce: bigint;
}) {
  return prepareHarnessMutation({
    mutation: "Credit",
    params: { amount: params.amount },
    accountID: params.account,
    sequence: params.nonce,
    keyType: 2,
    privateKey: USER_PRIVATE_KEY,
    address: params.address,
    chainId: anvil.id,
  });
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

async function withoutConsoleOutput<T>(run: () => Promise<T>): Promise<T> {
  const original = {
    debug: console.debug,
    error: console.error,
    info: console.info,
    log: console.log,
    warn: console.warn,
  };
  const noop = () => {};

  console.debug = noop;
  console.error = noop;
  console.info = noop;
  console.log = noop;
  console.warn = noop;

  try {
    return await run();
  } finally {
    console.debug = original.debug;
    console.error = original.error;
    console.info = original.info;
    console.log = original.log;
    console.warn = original.warn;
  }
}

test(`harness batch accepts ${MUTATION_COUNT.toLocaleString()} mutations`, async () => {
  const { createTypewriter } = await import("../src");
  const address = await deployHarness();
  const config = {
    address,
    account: SCHEDULER_ACCOUNT,
    chainId: anvil.id,
    rpcUrl: TEST_RPC_URL,
    sequencing: {
      order: "batch",
      batchIntervalMs: 10,
      submitIntervalMs: 3_600_000,
      batchOrder: ["CreateAccount", "Credit"],
    },
    database: { url: TEST_DB_URL, maxConnections: 2 },
    blockPollingIntervalMs: 3_600_000,
  } as const satisfies TypewriterConfig;

  const typewriter = await createTypewriter(Harness, config);

  const rootPublicKey = secp256k1PublicKey(USER_ACCOUNT.address);
  const account = nativeAccountID(2, rootPublicKey);

  const createAccount = prepareHarnessCreateAccount({
    keyType: 2,
    publicKey: rootPublicKey,
    privateKey: USER_PRIVATE_KEY,
    address,
    chainId: anvil.id,
  });
  await withoutConsoleOutput(() => typewriter.execute(createAccount));

  const mutations = await Promise.all(
    Array.from({ length: MUTATION_COUNT }, (_, index) =>
      harnessCreditMutation({
        address,
        account,
        amount: 1n,
        nonce: BigInt(index),
      }),
    ),
  );

  const mutationDurationsMs = new Array<number>(MUTATION_COUNT);
  const totalStart = performance.now();

  await withoutConsoleOutput(async () => {
    const promises = mutations.map(async (mutation, index) => {
      const mutationStart = performance.now();
      await typewriter.execute(mutation);
      mutationDurationsMs[index] = performance.now() - mutationStart;
    });

    await Promise.all(promises);
  });

  const totalDurationMs = performance.now() - totalStart;
  const sortedDurationsMs = mutationDurationsMs.toSorted((a, b) => a - b);
  const averageDurationMs =
    mutationDurationsMs.reduce((total, duration) => total + duration, 0) /
    MUTATION_COUNT;
  const mutationsPerSecond = MUTATION_COUNT / (totalDurationMs / 1_000);

  console.log(`
Harness batch benchmark
mutations: ${MUTATION_COUNT.toLocaleString()}
batch window: 10ms
total: ${formatMs(totalDurationMs)}
average: ${formatMs(averageDurationMs)}
p50: ${formatMs(percentile(sortedDurationsMs, 0.5))}
p95: ${formatMs(percentile(sortedDurationsMs, 0.95))}
p99: ${formatMs(percentile(sortedDurationsMs, 0.99))}
throughput: ${mutationsPerSecond.toFixed(2)} mutations/s`);
}, 300_000);
