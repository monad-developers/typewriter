/**
 * A settlement's gas, priced from each of its executions run alone in revm.
 * The rules behind it:
 *
 * - Intrinsic gas: every transaction pays 21,000, which a settlement pays once
 *   but each execution alone paid too.
 * - Monad: a cold storage access costs 8,100, and a warm one 100. There are
 *   no refunds.
 * - EIP-7623: a transaction pays at least 21,000 plus 10 per calldata token,
 *   where a zero byte is 1 token and any other byte 4.
 * - Monad MIP-8: storage is priced per page of 128 slots. A page is cold once
 *   and first written once per transaction, however many executions touch it.
 *   An access-list key warms its whole page.
 * - EIP-2930: an access list costs 2,400 per address and 1,900 per key, and
 *   what it lists is warm from the start. Without MIP-8 a key warms only its
 *   slot.
 * - EIP-7981 (MonadNext): an access list also costs 10 per token of its bytes,
 *   at 4 tokens a byte, and those tokens count toward the EIP-7623 floor.
 * - EIP-150: a call passes on at most 63/64 of the gas left.
 * - EIP-2200: an SSTORE needs more than 2,300 gas left.
 * - Monad caps a transaction's gas limit at 30M in every hardfork.
 */
import { Hex } from "ox";
import type { AccessList, ExecuteResult, Spec } from "typewriter-evm";

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

/** The hardforks with MIP-8. */
const PAGE_PRICED_SPECS: ReadonlySet<Spec> = new Set(["MonadTen", "MonadNext"]);
const PAGE_SHIFT = 7n;
/** What a warm storage access saves over a cold one. */
const COLD_READ_SAVING = 8_000;
const PAGE_WRITE_SAVING = 2_800;

const ACCESS_LIST_ADDRESS_GAS = 2_400;
const ACCESS_LIST_KEY_GAS = 1_900;
const ADDRESS_BYTES = 20;
const KEY_BYTES = 32;
const ACCESS_LIST_TOKENS_PER_BYTE = 4;

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

const isPagePriced = (executions: readonly Execution[]) =>
  executions.every(({ executeResult }) =>
    PAGE_PRICED_SPECS.has(executeResult.spec),
  );

/**
 * What one access-list key warms of `address`'s storage at `slot`: its page
 * under MIP-8, else the slot alone.
 */
const warmUnit = (pagePriced: boolean, address: string, slot: Hex.Hex) =>
  `${address.toLowerCase()}:${pagePriced ? BigInt(slot) >> PAGE_SHIFT : BigInt(slot)}`;

/**
 * The access list of `executions` as one transaction, so that no storage they
 * touch is ever cold: under MIP-8 each page they touch, as the lowest slot
 * they touch in it, and before it each slot they touch.
 *
 * @dev An account without storage keys is left out and stays cold.
 */
export function accessList(executions: readonly Execution[]): AccessList {
  const pagePriced = isPagePriced(executions);
  const units = new Map<
    string,
    { address: AccessList[number]["address"]; slots: Map<bigint, bigint> }
  >();
  for (const { executeResult } of executions) {
    for (const { address, storageKeys } of executeResult.access_list) {
      const id = address.toLowerCase();
      if (!units.has(id)) units.set(id, { address, slots: new Map() });
      const { slots } = units.get(id)!;
      for (const key of storageKeys) {
        const slot = BigInt(key);
        const unit = pagePriced ? slot >> PAGE_SHIFT : slot;
        const lowest = slots.get(unit);
        if (lowest === undefined || slot < lowest) slots.set(unit, slot);
      }
    }
  }
  return [...units.values()]
    .filter(({ slots }) => slots.size > 0)
    .map(({ address, slots }) => ({
      address,
      storageKeys: [...slots.values()]
        .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
        .map((slot) => Hex.fromNumber(slot, { size: 32 })),
    }));
}

/**
 * The gas limit of `executions` as one transaction with `accessList`: their
 * gas alone, less the base gas, the cold accesses the list warms and the
 * MIP-8 page costs they share, plus the list's own cost, but at least their
 * EIP-7623 floor together. A floor-bound execution's `gas_used` hides the
 * pages it shares, so the savings alone can come in under that floor. On
 * top, the 1/64 each call keeps back (EIP-150) and the SSTORE sentry
 * (EIP-2200).
 */
export function gasLimit(
  executions: readonly Execution[],
  accessList: AccessList,
): number {
  let gas = TRANSACTION_BASE_GAS;
  let tokens = 0;
  for (const { executeResult, calldata } of executions) {
    gas += executeResult.gas_used - TRANSACTION_BASE_GAS;
    for (const byte of Hex.toBytes(calldata)) tokens += byte === 0 ? 1 : 4;
  }

  const addresses = accessList.length;
  const keys = accessList.reduce(
    (n, { storageKeys }) => n + storageKeys.length,
    0,
  );
  gas += addresses * ACCESS_LIST_ADDRESS_GAS + keys * ACCESS_LIST_KEY_GAS;
  if (
    executions.some(({ executeResult }) => executeResult.spec === "MonadNext")
  ) {
    const listTokens =
      (addresses * ADDRESS_BYTES + keys * KEY_BYTES) *
      ACCESS_LIST_TOKENS_PER_BYTE;
    gas += FLOOR_GAS_PER_TOKEN * listTokens;
    tokens += listTokens;
  }

  // A listed key is warm in every execution that touches it. Under MIP-8,
  // an unlisted page is warm after the first execution that touches it.
  const pagePriced = isPagePriced(executions);
  const listed = new Set(
    accessList.flatMap(({ address, storageKeys }) =>
      storageKeys.map((key) => warmUnit(pagePriced, address, key)),
    ),
  );
  const touched = executions.map(({ executeResult }) => [
    ...new Set(
      executeResult.access_list.flatMap(({ address, storageKeys }) =>
        storageKeys.map((key) => warmUnit(pagePriced, address, key)),
      ),
    ),
  ]);
  const warmed = touched.flat().filter((unit) => listed.has(unit)).length;
  gas -= warmed * COLD_READ_SAVING;
  if (pagePriced) {
    const unlisted = touched.map((units) =>
      units.filter((unit) => !listed.has(unit)),
    );
    const writes = executions.map(({ executeResult }) =>
      executeResult.slot_writes.map(
        ({ slot }) => `${BigInt(slot) >> PAGE_SHIFT}`,
      ),
    );
    gas -=
      repeats(unlisted) * COLD_READ_SAVING +
      repeats(writes) * PAGE_WRITE_SAVING;
  }

  gas = Math.max(gas, TRANSACTION_BASE_GAS + FLOOR_GAS_PER_TOKEN * tokens);
  return gas + Math.ceil(gas / 64) + SSTORE_SENTRY_GAS;
}
