import { test } from "bun:test";
import { Effect } from "effect";
import { createEVM } from "../src/index.ts";

const MUTATION_COUNT = 10_000;

// Counter runtime bytecode — increments storage slot 0 by 1 on any call:
//   PUSH1 0x00 DUP1 SLOAD PUSH1 0x01 ADD SWAP1 SSTORE STOP
const COUNTER_CODE = "0x60008054600101905500";
const COUNTER_ADDR = "0x0000000000000000000000000000000000000c01";
const CALLER = "0x000000000000000000000000000000000000ca11";

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

test(`ffca-evm execute accepts ${MUTATION_COUNT.toLocaleString()} calls`, async () => {
  const program = Effect.gen(function* () {
    const evm = yield* createEVM();
    yield* evm.init({
      accounts: {
        [COUNTER_ADDR]: { code: COUNTER_CODE },
      },
    });

    const mutationDurationsMs = new Array<number>(MUTATION_COUNT);
    const totalStart = performance.now();

    for (let index = 0; index < MUTATION_COUNT; index += 1) {
      const mutationStart = performance.now();
      const result = yield* evm.execute({
        from: CALLER,
        to: COUNTER_ADDR,
        data: "0x",
      });
      if (result.success !== true) {
        throw new Error("execute failed during benchmark");
      }
      mutationDurationsMs[index] = performance.now() - mutationStart;
    }

    const totalDurationMs = performance.now() - totalStart;
    const sortedDurationsMs = mutationDurationsMs.toSorted((a, b) => a - b);
    const averageDurationMs =
      mutationDurationsMs.reduce((total, duration) => total + duration, 0) /
      MUTATION_COUNT;
    const mutationsPerSecond = MUTATION_COUNT / (totalDurationMs / 1_000);

    console.log(`
ffca-evm execute benchmark
mutations: ${MUTATION_COUNT.toLocaleString()}
total: ${formatMs(totalDurationMs)}
average: ${formatMs(averageDurationMs)}
p50: ${formatMs(percentile(sortedDurationsMs, 0.5))}
p95: ${formatMs(percentile(sortedDurationsMs, 0.95))}
p99: ${formatMs(percentile(sortedDurationsMs, 0.99))}
throughput: ${mutationsPerSecond.toFixed(2)} calls/s`);
  });

  await Effect.runPromise(Effect.scoped(program));
}, 300_000);
