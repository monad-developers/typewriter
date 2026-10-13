import { test } from "bun:test";
import { Effect } from "effect";
import {
  createEVM,
  type ExecuteParams,
  type InitParams,
} from "../src/index.ts";
import {
  callBurnData,
  loadCallGasCallee,
  loadCallGasCaller,
  loadTestToken,
  RECIPIENT_ADDR,
  SCHEDULER_ADDR,
  TOKEN_ADDR,
  tokenInit,
  transferData,
} from "./utils";

const MUTATION_COUNT = 10_000;

// Counter runtime bytecode — increments storage slot 0 by 1 on any call:
//   PUSH1 0x00 DUP1 SLOAD PUSH1 0x01 ADD SWAP1 SSTORE STOP
const COUNTER_CODE = "0x60008054600101905500";
const COUNTER_ADDR = "0x0000000000000000000000000000000000000c01";
const CALLER = "0x000000000000000000000000000000000000ca11";
const CALL_BURN_CALLEE_ADDR = "0x000000000000000000000000000000000000ca1e";
const CALL_BURN_CALLER_ADDR = "0x000000000000000000000000000000000000ca1f";

type Workload = {
  readonly name: string;
  readonly init: InitParams;
  readonly call: ExecuteParams;
};

function percentile(values: readonly number[], p: number): number {
  const index = Math.min(
    values.length - 1,
    Math.floor((values.length - 1) * p),
  );
  return values[index]!;
}

function formatUs(durationMs: number): string {
  return `${(durationMs * 1_000).toFixed(1)}µs`;
}

async function loadWorkloads(): Promise<readonly Workload[]> {
  const token = await loadTestToken();
  const callee = await loadCallGasCallee();
  const caller = await loadCallGasCaller();
  return [
    {
      // Bare SLOAD/SSTORE. Gas estimation converges on the first attempt, so
      // this is the floor for one execute round trip.
      name: "counter",
      init: { accounts: { [COUNTER_ADDR]: { code: COUNTER_CODE } } },
      call: { from: CALLER, to: COUNTER_ADDR, data: "0x" },
    },
    {
      name: "erc20 transfer",
      init: tokenInit(token).params,
      call: {
        from: SCHEDULER_ADDR,
        to: TOKEN_ADDR,
        data: transferData(RECIPIENT_ADDR, 1n),
      },
    },
    {
      // A nested CALL adds EIP-150 63/64 headroom, so gas_used is not a
      // sufficient gas limit. Real Typewriter mutations have this shape:
      // signature verification calls a precompile.
      name: "nested call",
      init: {
        chain_id: 31337,
        accounts: {
          [CALL_BURN_CALLEE_ADDR]: { code: callee.deployedBytecode.object },
          [CALL_BURN_CALLER_ADDR]: { code: caller.deployedBytecode.object },
        },
      },
      call: {
        from: SCHEDULER_ADDR,
        to: CALL_BURN_CALLER_ADDR,
        data: callBurnData(CALL_BURN_CALLEE_ADDR, 10n),
      },
    },
  ];
}

test(`typewriter-evm execute accepts ${MUTATION_COUNT.toLocaleString()} calls`, async () => {
  const workloads = await loadWorkloads();
  const rows: string[] = [];

  for (const workload of workloads) {
    const program = Effect.gen(function* () {
      const evm = yield* createEVM();
      yield* evm.init(workload.init);

      const durationsMs = new Array<number>(MUTATION_COUNT);
      const totalStart = performance.now();
      for (let index = 0; index < MUTATION_COUNT; index += 1) {
        const start = performance.now();
        const result = yield* evm.execute(workload.call);
        if (result.success !== true) {
          throw new Error(`${workload.name} execute failed during benchmark`);
        }
        durationsMs[index] = performance.now() - start;
      }
      const totalMs = performance.now() - totalStart;

      const sorted = durationsMs.toSorted((a, b) => a - b);
      rows.push(
        [
          workload.name.padStart(14),
          formatUs(totalMs / MUTATION_COUNT).padStart(9),
          formatUs(percentile(sorted, 0.5)).padStart(9),
          formatUs(percentile(sorted, 0.99)).padStart(9),
          Math.round(MUTATION_COUNT / (totalMs / 1_000))
            .toLocaleString()
            .padStart(10),
        ].join("  "),
      );
    });
    await Effect.runPromise(Effect.scoped(program));
  }

  console.log(`
typewriter-evm execute benchmark
calls per workload: ${MUTATION_COUNT.toLocaleString()}
      workload    average        p50        p99     calls/s
${rows.join("\n")}`);
}, 300_000);
