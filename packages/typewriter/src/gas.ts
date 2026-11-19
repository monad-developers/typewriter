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
    "gas_used" | "access_list" | "slot_writes"
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
 * What one access-list key warms of `address`'s storage at `slot` under
 * `spec`: its page with MIP-8, else the slot alone.
 */
const warmUnit = (spec: Spec, address: string, slot: Hex.Hex) =>
  `${address.toLowerCase()}:${PAGE_PRICED_SPECS.has(spec) ? BigInt(slot) >> PAGE_SHIFT : BigInt(slot)}`;

/**
 * The access list of `executions` as one transaction under `spec`, so that no
 * storage they touch is ever cold: under MIP-8 each page they touch, as the lowest slot
 * they touch in it, and before it each slot they touch.
 *
 * @dev An account without storage keys is left out and stays cold.
 */
export function accessList(
  spec: Spec,
  executions: readonly Execution[],
): AccessList {
  const pagePriced = PAGE_PRICED_SPECS.has(spec);
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
 * A settlement's gas as executions join it, with the access list of them all
 * (see `accessList`): their gas alone, less the base gas and the cold
 * accesses the list warms, plus the list's own cost. Under MIP-8 a page is
 * also first written once.
 */
type Estimate = {
  gas: number;
  /** The EIP-7623 tokens of the calldata and the list. */
  tokens: number;
  addresses: Set<string>;
  /** The listed keys, as what each warms. */
  keys: Set<string>;
  /** The pages of the called contract written so far. */
  writes: Set<string>;
};

const emptyEstimate = (): Estimate => ({
  gas: TRANSACTION_BASE_GAS,
  tokens: 0,
  addresses: new Set(),
  keys: new Set(),
  writes: new Set(),
});

function addExecution(
  spec: Spec,
  estimate: Estimate,
  { executeResult, calldata }: Execution,
) {
  estimate.gas += executeResult.gas_used - TRANSACTION_BASE_GAS;
  for (const byte of Hex.toBytes(calldata)) {
    estimate.tokens += byte === 0 ? 1 : 4;
  }

  // An address or key costs once, when it joins the list.
  const list = (gas: number, bytes: number) => {
    estimate.gas += gas;
    if (spec === "MonadNext") {
      const tokens = bytes * ACCESS_LIST_TOKENS_PER_BYTE;
      estimate.gas += FLOOR_GAS_PER_TOKEN * tokens;
      estimate.tokens += tokens;
    }
  };
  const warmed = new Set<string>();
  for (const { address, storageKeys } of executeResult.access_list) {
    if (storageKeys.length === 0) continue;
    const id = address.toLowerCase();
    if (!estimate.addresses.has(id)) {
      estimate.addresses.add(id);
      list(ACCESS_LIST_ADDRESS_GAS, ADDRESS_BYTES);
    }
    for (const key of storageKeys) warmed.add(warmUnit(spec, address, key));
  }
  // A listed key is warm in every execution that touches it.
  for (const unit of warmed) {
    if (!estimate.keys.has(unit)) {
      estimate.keys.add(unit);
      list(ACCESS_LIST_KEY_GAS, KEY_BYTES);
    }
    estimate.gas -= COLD_READ_SAVING;
  }

  if (!PAGE_PRICED_SPECS.has(spec)) return;
  const pages = executeResult.slot_writes.map(
    ({ slot }) => `${BigInt(slot) >> PAGE_SHIFT}`,
  );
  for (const page of new Set(pages)) {
    if (estimate.writes.has(page)) estimate.gas -= PAGE_WRITE_SAVING;
    else estimate.writes.add(page);
  }
}

/**
 * The gas limit of `estimate`: its gas, but at least its EIP-7623 floor. A
 * floor-bound execution's `gas_used` hides the pages it shares, so the
 * savings alone can come in under that floor. On top, the 1/64 each call
 * keeps back (EIP-150) and the SSTORE sentry (EIP-2200).
 */
function limitOf({ gas, tokens }: Estimate): number {
  const charged = Math.max(
    gas,
    TRANSACTION_BASE_GAS + FLOOR_GAS_PER_TOKEN * tokens,
  );
  return charged + Math.ceil(charged / 64) + SSTORE_SENTRY_GAS;
}

/**
 * Groups `items` in order so each group's gas limit under `spec` fits under
 * the cap.
 *
 * @dev Settlements are not capped in bytes.
 */
export function groupByGas<item extends Execution>(
  spec: Spec,
  items: readonly item[],
): item[][] {
  const groups: item[][] = [];
  let estimate = emptyEstimate();
  for (const item of items) {
    addExecution(spec, estimate, item);
    if (groups.length === 0 || limitOf(estimate) > TX_GAS_LIMIT_CAP) {
      groups.push([]);
      estimate = emptyEstimate();
      addExecution(spec, estimate, item);
    }
    groups.at(-1)!.push(item);
  }
  return groups;
}

/**
 * The gas limit of `executions` as one transaction under `spec`, signed with
 * their `accessList`.
 */
export function gasLimit(spec: Spec, executions: readonly Execution[]): number {
  const estimate = emptyEstimate();
  for (const execution of executions) addExecution(spec, estimate, execution);
  return limitOf(estimate);
}
