import { test } from "bun:test";
import { anvil } from "viem/chains";
import type { TypewriterConfig } from "../src";
import { formatMs, percentile, withCapturedLogs } from "./benchmark-utils";
import Counter from "./contracts/src/Counter.sol";
import {
  SCHEDULER_ACCOUNT,
  TEST_DB_URL,
  TEST_RPC_URL,
  USER_PRIVATE_KEY,
} from "./setup";
import {
  deployCounter,
  prepareCounterAdd,
  prepareCounterCreateAccount,
} from "./utils";

process.env.NODE_ENV = "production";

const MUTATION_COUNT = 10_000;

// How the benchmark sends mutations:
// - closed: `inFlight` clients that each wait for a response before they send
//   the next mutation. 1 client measures pure latency. Closed-loop clients
//   move in lockstep with batches, so work cannot overlap a commit.
// - open: send at a fixed rate whatever the responses, like many independent
//   users. Above the runtime's capacity, latency grows with each mutation.
type Load =
  | { readonly mode: "closed"; readonly inFlight: number }
  | { readonly mode: "open"; readonly perSecond: number };

const LOADS: readonly Load[] = [
  { mode: "closed", inFlight: 1 },
  { mode: "closed", inFlight: 32 },
  { mode: "open", perSecond: 4_000 },
  { mode: "open", perSecond: 8_000 },
];

function describeLoad(load: Load): string {
  return load.mode === "closed"
    ? `${load.inFlight} in flight`
    : `open loop at ${load.perSecond.toLocaleString()}/s`;
}

function counterAddMutation(params: {
  readonly address: `0x${string}`;
  readonly amount: bigint;
  readonly nonce: bigint;
}) {
  return prepareCounterAdd({
    privateKey: USER_PRIVATE_KEY,
    amount: params.amount,
    sequence: params.nonce,
    address: params.address,
    chainId: anvil.id,
  });
}

for (const load of LOADS) {
  test(`counter accepts ${MUTATION_COUNT.toLocaleString()} mutations, ${describeLoad(load)}`, async () => {
    const { createTypewriter } = await import("../src");
    const address = await deployCounter();
    const config = {
      address,
      account: SCHEDULER_ACCOUNT,
      chainId: anvil.id,
      rpcUrl: TEST_RPC_URL,
      sequencing: { order: "fifo", submitIntervalMs: 3_600_000 },
      database: { url: TEST_DB_URL, maxConnections: 2 },
      blockPollingIntervalMs: 3_600_000,
    } as const satisfies TypewriterConfig;

    const typewriter = await createTypewriter(Counter, config);

    const createAccount = await prepareCounterCreateAccount({
      privateKey: USER_PRIVATE_KEY,
      address,
      chainId: anvil.id,
    });
    await withCapturedLogs(() => typewriter.execute(createAccount));

    const mutations = await Promise.all(
      Array.from({ length: MUTATION_COUNT }, (_, index) =>
        counterAddMutation({
          address,
          amount: 1n,
          nonce: BigInt(index),
        }),
      ),
    );

    const mutationDurationsMs = new Array<number>(MUTATION_COUNT);
    const totalStart = performance.now();

    // Mutations are always sent in nonce order.
    let nextIndex = 0;
    const send = async () => {
      const index = nextIndex++;
      const mutationStart = performance.now();
      await typewriter.execute(mutations[index]!);
      mutationDurationsMs[index] = performance.now() - mutationStart;
    };

    const { phases } = await withCapturedLogs(async () => {
      if (load.mode === "closed") {
        const client = async () => {
          while (nextIndex < MUTATION_COUNT) await send();
        };
        await Promise.all(Array.from({ length: load.inFlight }, client));
        return;
      }

      // Timers fire about every 1ms at best, so send all due mutations on
      // each tick.
      const sent: Promise<void>[] = [];
      while (nextIndex < MUTATION_COUNT) {
        const elapsedSeconds = (performance.now() - totalStart) / 1_000;
        const due = Math.min(
          MUTATION_COUNT,
          Math.floor(elapsedSeconds * load.perSecond) + 1,
        );
        while (nextIndex < due) sent.push(send());
        await Bun.sleep(1);
      }
      await Promise.all(sent);
    });

    const totalDurationMs = performance.now() - totalStart;
    const sortedDurationsMs = mutationDurationsMs.toSorted((a, b) => a - b);
    const averageDurationMs =
      mutationDurationsMs.reduce((total, duration) => total + duration, 0) /
      MUTATION_COUNT;
    const mutationsPerSecond = MUTATION_COUNT / (totalDurationMs / 1_000);

    console.log(`
Counter benchmark
mutations: ${MUTATION_COUNT.toLocaleString()}
load: ${describeLoad(load)}
total: ${formatMs(totalDurationMs)}
average: ${formatMs(averageDurationMs)}
p50: ${formatMs(percentile(sortedDurationsMs, 0.5))}
p95: ${formatMs(percentile(sortedDurationsMs, 0.95))}
p99: ${formatMs(percentile(sortedDurationsMs, 0.99))}
throughput: ${mutationsPerSecond.toFixed(2)} mutations/s
${phases}`);
  }, 120_000);
}
