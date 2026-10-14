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

Object.assign(process.env, {
  NODE_ENV: "production",
  TYPEWRITER_LOG_LEVEL: "info",
});

const LATENCY_MUTATION_COUNT = 1_000;
const THROUGHPUT_MUTATION_COUNT = 10_000;

test("harness benchmark", async () => {
  const { createTypewriter } = await import("../src");
  const address = await deployHarness();
  const config = {
    address,
    account: SCHEDULER_ACCOUNT,
    chainId: anvil.id,
    rpcUrl: TEST_RPC_URL,
    database: { url: TEST_DB_URL },
  } as const satisfies TypewriterConfig;

  const rootPublicKey = secp256k1PublicKey(USER_ACCOUNT.address);
  const account = nativeAccountID(2, rootPublicKey);
  const createAccount = prepareHarnessCreateAccount({
    keyType: 2,
    publicKey: rootPublicKey,
    privateKey: USER_PRIVATE_KEY,
    address,
    chainId: anvil.id,
  });
  const mutations = await Promise.all(
    Array.from(
      { length: LATENCY_MUTATION_COUNT + THROUGHPUT_MUTATION_COUNT },
      (_, index) =>
        prepareHarnessMutation({
          mutation: "Credit",
          params: { amount: 1n },
          accountID: account,
          sequence: BigInt(index),
          keyType: 2,
          privateKey: USER_PRIVATE_KEY,
          address,
          chainId: anvil.id,
        }),
    ),
  );
  const latencyMutations = mutations.slice(0, LATENCY_MUTATION_COUNT);
  const throughputMutations = mutations.slice(LATENCY_MUTATION_COUNT);

  const typewriter = await createTypewriter(Harness, config);
  await typewriter.execute(createAccount);

  const latenciesMs: number[] = [];
  for (const mutation of latencyMutations) {
    const start = performance.now();
    await typewriter.execute(mutation);
    latenciesMs.push(performance.now() - start);
  }

  const start = performance.now();
  await Promise.all(
    throughputMutations.map((mutation) => typewriter.execute(mutation)),
  );
  const throughputDurationMs = performance.now() - start;

  latenciesMs.sort((a, b) => a - b);
  const averageMs =
    latenciesMs.reduce((total, latency) => total + latency, 0) /
    LATENCY_MUTATION_COUNT;
  const p50Ms = latenciesMs[Math.floor(LATENCY_MUTATION_COUNT * 0.5)]!;
  const p99Ms = latenciesMs[Math.floor(LATENCY_MUTATION_COUNT * 0.99)]!;
  const mutationsPerSecond =
    THROUGHPUT_MUTATION_COUNT / (throughputDurationMs / 1_000);

  console.log(`
Harness benchmark
single user, ${LATENCY_MUTATION_COUNT.toLocaleString()} sequential mutations:
  average ${averageMs.toFixed(2)}ms, p50 ${p50Ms.toFixed(2)}ms, p99 ${p99Ms.toFixed(2)}ms
max throughput, ${THROUGHPUT_MUTATION_COUNT.toLocaleString()} concurrent mutations:
  ${Math.round(mutationsPerSecond).toLocaleString()} mutations/s`);
}, 300_000);
