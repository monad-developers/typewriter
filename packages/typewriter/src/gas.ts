/**
 * A settlement's gas, priced from each of its executions run alone in revm.
 * The rules behind it:
 *
 * - Intrinsic gas: every transaction pays 21,000, which a settlement pays once
 *   but each execution alone paid too.
 * - EIP-7623: a transaction pays at least 21,000 plus 10 per calldata token,
 *   where a zero byte is 1 token and any other byte 4.
 * - Monad MIP-8: storage is priced per page of 128 slots. A page is cold once
 *   and first written once per transaction, however many executions touch it.
 * - EIP-150: a call passes on at most 63/64 of the gas left.
 * - EIP-2200: an SSTORE needs more than 2,300 gas left.
 * - Monad caps a transaction's gas limit at 30M in every hardfork.
 */
import { Hex } from "ox";
import type { ExecuteResult, Spec } from "typewriter-evm";

/** One execution's run alone, and the calldata it ran with. */
type Execution = {
  executeResult: Pick<
    Extract<ExecuteResult, { status: "success" }>,
    "gas_used" | "access_list" | "slot_writes" | "spec"
  >;
  calldata: Hex.Hex;
};

const TX_GAS_LIMIT_CAP = 30_000_000;
const TRANSACTION_BASE_GAS = 21_000;
const FLOOR_GAS_PER_TOKEN = 10;
const SSTORE_SENTRY_GAS = 2_300;

/** The hardforks with MIP-8, and what it saves on a page already touched. */
const PAGE_PRICED_SPECS: ReadonlySet<Spec> = new Set(["MonadTen", "MonadNext"]);
const PAGE_SHIFT = 7n;
const COLD_READ_SAVING = 8_000;
const PAGE_WRITE_SAVING = 2_800;

/** The most gas a settlement can use, so its gas limit fits under the cap. */
export const SETTLEMENT_GAS = Math.floor(
  ((TX_GAS_LIMIT_CAP - SSTORE_SENTRY_GAS) * 64) / 65,
);

/**
 * Groups `items` in order so each group settles in one transaction.
 *
 * @dev Settlements are not capped in bytes.
 */
export function groupByGas<item extends Execution>(
  items: readonly item[],
): item[][] {
  const groups: item[][] = [];
  let gas = 0;
  for (const item of items) {
    const itemGas = item.executeResult.gas_used - TRANSACTION_BASE_GAS;
    gas += itemGas;
    if (groups.length === 0 || gas > SETTLEMENT_GAS - TRANSACTION_BASE_GAS) {
      groups.push([]);
      gas = itemGas;
    }
    groups.at(-1)!.push(item);
  }
  return groups;
}

/** How many times the keys come up again after their first set. */
function repeats(sets: readonly (readonly string[])[]): number {
  const seen = new Set<string>();
  let n = 0;
  for (const keys of sets) {
    for (const key of new Set(keys)) {
      if (seen.has(key)) n++;
      else seen.add(key);
    }
  }
  return n;
}

/**
 * The gas limit of `executions` as one transaction: their gas alone, less
 * the base gas and the MIP-8 page costs they share, but at least their
 * EIP-7623 floor together. A floor-bound execution's `gas_used` hides the
 * pages it shares, so the savings alone can come in under that floor. On
 * top, the 1/64 each call keeps back (EIP-150) and the SSTORE sentry
 * (EIP-2200).
 */
export function gasLimit(executions: readonly Execution[]): number {
  let gas = TRANSACTION_BASE_GAS;
  let tokens = 0;
  for (const { executeResult, calldata } of executions) {
    gas += executeResult.gas_used - TRANSACTION_BASE_GAS;
    for (const byte of Hex.toBytes(calldata)) tokens += byte === 0 ? 1 : 4;
  }

  const results = executions.map(({ executeResult }) => executeResult);
  if (results.every(({ spec }) => PAGE_PRICED_SPECS.has(spec))) {
    const page = (slot: Hex.Hex) => BigInt(slot) >> PAGE_SHIFT;
    const reads = results.map(({ access_list }) =>
      access_list.flatMap(({ address, storageKeys }) =>
        storageKeys.map((key) => `${address.toLowerCase()}:${page(key)}`),
      ),
    );
    const writes = results.map(({ slot_writes }) =>
      slot_writes.map(({ slot }) => `${page(slot)}`),
    );
    gas -=
      repeats(reads) * COLD_READ_SAVING + repeats(writes) * PAGE_WRITE_SAVING;
  }

  gas = Math.max(gas, TRANSACTION_BASE_GAS + FLOOR_GAS_PER_TOKEN * tokens);
  return gas + Math.ceil(gas / 64) + SSTORE_SENTRY_GAS;
}
