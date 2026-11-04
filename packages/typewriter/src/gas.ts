import type { ExecuteResult } from "typewriter-evm";
import { TX_GAS_LIMIT_CAP } from "./typewriter-constants";

/** What a settlement's gas is priced from: one execution's run alone in revm. */
type Execution = Pick<
  Extract<ExecuteResult, { status: "success" }>,
  "gas_used" | "access_list" | "slot_writes"
>;

/** The intrinsic gas of a transaction, which a settlement pays once. */
const TRANSACTION_BASE_GAS = 21_000;

/** Monad's storage pages hold `2 ** PAGE_SHIFT` slots. */
const PAGE_SHIFT = 7n;
/** What Monad saves on a page already read in the transaction. */
const COLD_READ_SAVING = 8_000;
/** What Monad saves on a page the transaction already wrote. */
const PAGE_WRITE_SAVING = 2_800;

/** The gas an SSTORE requires left, which a gas limit must leave. */
const SSTORE_SENTRY_GAS = 2_300;

/** The gas limit for `gas`: the 1/64 each call keeps back, and the SSTORE sentry. */
function gasLimitFor(gas: number): number {
  return gas + Math.ceil(gas / 64) + SSTORE_SENTRY_GAS;
}

/** The most gas a settlement can take, so its gas limit fits a transaction. */
export const SETTLEMENT_GAS = Math.floor(
  ((TX_GAS_LIMIT_CAP - SSTORE_SENTRY_GAS) * 64) / 65,
);

/**
 * Groups `items` in order so each group settles in one transaction. Alone,
 * each paid the base gas a settlement pays once.
 *
 * @dev Settlements are not capped in bytes.
 */
export function groupByGas<item>(
  items: readonly item[],
  executionOf: (item: item) => Execution,
): item[][] {
  const groups: item[][] = [];
  let gas = 0;
  for (const item of items) {
    const itemGas = executionOf(item).gas_used - TRANSACTION_BASE_GAS;
    gas += itemGas;
    if (groups.length === 0 || gas > SETTLEMENT_GAS - TRANSACTION_BASE_GAS) {
      groups.push([]);
      gas = itemGas;
    }
    groups.at(-1)!.push(item);
  }
  return groups;
}

/**
 * The gas of `executions` as one transaction: their gas alone, less what they
 * share. The base gas is paid once, and each storage page is cold once and
 * first written once. It never comes in under the chain's.
 */
function estimateGas(executions: readonly Execution[]): number {
  let gas = TRANSACTION_BASE_GAS;
  const reads = new Map<string, number>();
  const writes = new Map<string, number>();
  const count = (counts: Map<string, number>, keys: Set<string>) => {
    for (const key of keys) counts.set(key, (counts.get(key) ?? 0) + 1);
  };
  for (const execution of executions) {
    gas += execution.gas_used - TRANSACTION_BASE_GAS;
    count(
      reads,
      new Set(
        execution.access_list.flatMap(({ address, storageKeys }) =>
          storageKeys.map(
            (key) => `${address.toLowerCase()}:${BigInt(key) >> PAGE_SHIFT}`,
          ),
        ),
      ),
    );
    count(
      writes,
      new Set(
        execution.slot_writes.map(
          ({ slot }) => `${BigInt(slot) >> PAGE_SHIFT}`,
        ),
      ),
    );
  }
  for (const n of reads.values()) gas -= (n - 1) * COLD_READ_SAVING;
  for (const n of writes.values()) gas -= (n - 1) * PAGE_WRITE_SAVING;
  return gas;
}

/** The gas limit of a settlement of `executions`. */
export function settlementGasLimit(executions: readonly Execution[]): number {
  return gasLimitFor(estimateGas(executions));
}
