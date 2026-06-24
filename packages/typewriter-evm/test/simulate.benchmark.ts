import { test } from "bun:test";
import { Effect } from "effect";
import { Hex } from "ox";
import { createEVM } from "../src/index.ts";
import {
  callBurnData,
  loadCallGasCallee,
  loadCallGasCaller,
  SCHEDULER_ADDR,
} from "./utils";

const JOURNAL_COUNT = 120;
const SIMULATION_ITERATIONS = 8;
const SIMULATED_JOURNAL_COUNTS = [0, 1, 5, 10, 20, 40, 60, 120] as const;
const EVM_WORKLOAD_ITERATIONS = 5;
const CALL_BURN_COUNTS = [0n, 250n, 1_000n, 2_500n, 5_000n] as const;
const LARGE_CALLDATA_BYTES = 64 * 1024;
const ACCESS_LIST_MODES = ["discovered", "cached"] as const;

// Runtime bytecode: SSTORE(calldataload(0), 1); STOP.
const SLOT_WRITER_CODE = "0x60016000355500";
const SLOT_WRITER_ADDR = "0x0000000000000000000000000000000000005107";
const CALLER = "0x000000000000000000000000000000000000ca11";
const CALL_BURN_CALLEE_ADDR = "0x000000000000000000000000000000000000ca1e";
const CALL_BURN_CALLER_ADDR = "0x000000000000000000000000000000000000ca11";

type Summary = {
  readonly journalCount: number;
  readonly averageMs: number;
  readonly p50Ms: number;
  readonly p95Ms: number;
  readonly perJournalMs: number | undefined;
};

function percentile(values: readonly number[], p: number): number {
  const index = Math.min(
    values.length - 1,
    Math.floor((values.length - 1) * p),
  );
  return values[index]!;
}

function average(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0) / values.length;
}

function formatMs(durationMs: number): string {
  return `${durationMs.toFixed(2)}ms`;
}

function formatPerJournal(value: number | undefined): string {
  if (value === undefined) return "n/a";
  return formatMs(value);
}

function writeSlotData(index: number): Hex.Hex {
  return Hex.fromNumber(BigInt(index), { size: 32 });
}

function appendTrailingCalldata(data: Hex.Hex, byteCount: number): Hex.Hex {
  return `${data}${"11".repeat(byteCount)}` as Hex.Hex;
}

function callBurnLargeData(burnCount: bigint): Hex.Hex {
  return appendTrailingCalldata(
    callBurnData(CALL_BURN_CALLEE_ADDR, burnCount),
    LARGE_CALLDATA_BYTES,
  );
}

test("typewriter-evm simulate scales with optimistic journal count", async () => {
  const program = Effect.gen(function* () {
    const evm = yield* createEVM();
    yield* evm.init({
      accounts: {
        [SLOT_WRITER_ADDR]: { code: SLOT_WRITER_CODE },
      },
    });

    const journalIds: number[] = [];
    for (let index = 0; index < JOURNAL_COUNT; index += 1) {
      const result = yield* evm.execute({
        from: CALLER,
        to: SLOT_WRITER_ADDR,
        data: writeSlotData(index),
      });
      if (result.success !== true || result.journal_id === undefined) {
        throw new Error("execute failed while preparing simulate benchmark");
      }
      journalIds.push(result.journal_id);
    }

    const summaries: Summary[] = [];
    for (const journalCount of SIMULATED_JOURNAL_COUNTS) {
      const durationsMs: number[] = [];
      const selectedJournalIds = journalIds.slice(0, journalCount);

      for (
        let iteration = 0;
        iteration < SIMULATION_ITERATIONS;
        iteration += 1
      ) {
        const startedAtMs = performance.now();
        const result = yield* evm.simulate({
          from: CALLER,
          to: SLOT_WRITER_ADDR,
          data: writeSlotData(JOURNAL_COUNT + iteration),
          journal_ids: selectedJournalIds,
        });
        if (result.success !== true) {
          throw new Error("simulate failed during benchmark");
        }
        durationsMs.push(performance.now() - startedAtMs);
      }

      const sortedDurationsMs = durationsMs.toSorted((a, b) => a - b);
      const averageMs = average(durationsMs);
      summaries.push({
        journalCount,
        averageMs,
        p50Ms: percentile(sortedDurationsMs, 0.5),
        p95Ms: percentile(sortedDurationsMs, 0.95),
        perJournalMs: journalCount === 0 ? undefined : averageMs / journalCount,
      });
    }

    const rows = summaries
      .map(
        (summary) =>
          `${summary.journalCount.toString().padStart(8)}  ${formatMs(
            summary.averageMs,
          ).padStart(10)}  ${formatMs(summary.p50Ms).padStart(
            10,
          )}  ${formatMs(summary.p95Ms).padStart(10)}  ${formatPerJournal(
            summary.perJournalMs,
          ).padStart(12)}`,
      )
      .join("\n");

    console.log(`
typewriter-evm simulate benchmark
prepared journals: ${JOURNAL_COUNT.toLocaleString()}
iterations per count: ${SIMULATION_ITERATIONS.toLocaleString()}
journals     average         p50         p95  avg/journal
${rows}`);
  });

  await Effect.runPromise(Effect.scoped(program));
}, 300_000);

test("typewriter-evm simulate scales with EVM workload", async () => {
  const calleeArtifact = await loadCallGasCallee();
  const callerArtifact = await loadCallGasCaller();

  const program = Effect.gen(function* () {
    const evm = yield* createEVM();
    yield* evm.init({
      chain_id: 31337,
      accounts: {
        [CALL_BURN_CALLEE_ADDR]: {
          code: calleeArtifact.deployedBytecode.object,
        },
        [CALL_BURN_CALLER_ADDR]: {
          code: callerArtifact.deployedBytecode.object,
        },
      },
    });

    const journalIdsByBurnCount = new Map<bigint, number>();
    for (const burnCount of CALL_BURN_COUNTS) {
      const result = yield* evm.execute({
        from: SCHEDULER_ADDR,
        to: CALL_BURN_CALLER_ADDR,
        data: callBurnLargeData(burnCount),
      });
      if (result.success !== true || result.journal_id === undefined) {
        throw new Error("callBurn execute failed while preparing benchmark");
      }
      journalIdsByBurnCount.set(burnCount, result.journal_id);
    }

    const rows: string[] = [];
    for (const mode of ACCESS_LIST_MODES) {
      for (const burnCount of CALL_BURN_COUNTS) {
        const durationsMs: number[] = [];
        for (
          let iteration = 0;
          iteration < EVM_WORKLOAD_ITERATIONS;
          iteration += 1
        ) {
          const startedAtMs = performance.now();
          const result = yield* evm.simulate({
            from: SCHEDULER_ADDR,
            to: CALL_BURN_CALLER_ADDR,
            data: callBurnLargeData(burnCount),
            journal_ids:
              mode === "cached" ? [journalIdsByBurnCount.get(burnCount)!] : [],
          });
          if (result.success !== true) {
            throw new Error("callBurn simulate failed during benchmark");
          }
          durationsMs.push(performance.now() - startedAtMs);
        }

        const sortedDurationsMs = durationsMs.toSorted((a, b) => a - b);
        rows.push(
          `${mode.padStart(10)}  ${burnCount.toString().padStart(10)}  ${formatMs(
            average(durationsMs),
          ).padStart(10)}  ${formatMs(
            percentile(sortedDurationsMs, 0.5),
          ).padStart(
            10,
          )}  ${formatMs(percentile(sortedDurationsMs, 0.95)).padStart(10)}`,
        );
      }
    }

    console.log(`
typewriter-evm simulate EVM workload benchmark
iterations per count: ${EVM_WORKLOAD_ITERATIONS.toLocaleString()}
trailing calldata: ${LARGE_CALLDATA_BYTES.toLocaleString()} bytes
access       burn count     average         p50         p95
${rows.join("\n")}`);
  });

  await Effect.runPromise(Effect.scoped(program));
}, 300_000);
