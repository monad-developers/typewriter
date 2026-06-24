import { test } from "bun:test";
import { anvil } from "viem/chains";
import type { TypewriterConfig, TypewriterMutation } from "../src";
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
  encodeHarnessSignature,
  type HARNESS_MUTATIONS,
  type HARNESS_SIGNATURE_PARAMS,
  harnessAccountId,
  secp256k1PublicKey,
  signHarness,
} from "./utils";

process.env.NODE_ENV = "production";

const MUTATION_COUNT = 10_000;

function harnessSignature(params: {
  readonly account: `0x${string}`;
  readonly keyId: bigint;
  readonly keyType: number;
  readonly rawSignature: `0x${string}`;
}) {
  return encodeHarnessSignature(params);
}

function harnessCreditMutation(params: {
  readonly address: `0x${string}`;
  readonly account: `0x${string}`;
  readonly amount: bigint;
  readonly nonce: bigint;
}): TypewriterMutation<
  "Credit",
  typeof HARNESS_MUTATIONS.Credit,
  typeof HARNESS_SIGNATURE_PARAMS
> {
  const mutationParams = {
    account: params.account,
    keyId: 0n,
    amount: params.amount,
    nonce: params.nonce,
  };

  return {
    name: "Credit",
    params: mutationParams,
    signature: harnessSignature({
      account: params.account,
      keyId: 0n,
      keyType: 2,
      rawSignature: signHarness({
        keyType: 2,
        privateKey: USER_PRIVATE_KEY,
        mutation: "Credit",
        params: mutationParams,
        address: params.address,
        chainId: anvil.id,
      }),
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
      batchOrder: ["Initialize", "Credit"],
    },
    database: { url: TEST_DB_URL, maxConnections: 2 },
    blockPollingIntervalMs: 3_600_000,
  } as const satisfies TypewriterConfig;

  const typewriter = await createTypewriter(Harness, config);

  const rootPublicKey = secp256k1PublicKey(USER_ACCOUNT.address);
  const account = harnessAccountId(rootPublicKey);

  await withoutConsoleOutput(() =>
    typewriter.execute({
      name: "Initialize",
      params: {
        rootKeyType: 2,
        rootPublicKey,
      },
      signature: harnessSignature({
        account,
        keyId: 0n,
        keyType: 2,
        rawSignature: "0x",
      }),
    } as Parameters<typeof typewriter.execute>[0]),
  );

  const mutations = Array.from({ length: MUTATION_COUNT }, (_, index) =>
    harnessCreditMutation({
      address,
      account,
      amount: 1n,
      nonce: BigInt(index),
    }),
  );

  const mutationDurationsMs = new Array<number>(MUTATION_COUNT);
  const totalStart = performance.now();

  await withoutConsoleOutput(async () => {
    const promises = mutations.map(async (mutation, index) => {
      const mutationStart = performance.now();
      await typewriter.execute(
        mutation as unknown as Parameters<typeof typewriter.execute>[0],
      );
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
