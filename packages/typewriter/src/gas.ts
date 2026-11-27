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
 * - Typewriter.sol: `execute` checks its scheduler credential once, after its
 *   executions. revm runs each execution alone from the scheduler, so each
 *   of their runs checks it without a signature. A settlement checks it once,
 *   with the scheduler's signature unless the relayer is the scheduler.
 */
import { type Address, Hex } from "ox";
import type { AccessList, ExecuteResult, Spec } from "typewriter-evm";

/** One execution's run alone, and the calldata it ran with. */
type Execution = {
  executeResult: Pick<
    ExecuteResult,
    "gas_used" | "access_list" | "slot_writes"
  >;
  calldata: Hex.Hex;
};

/** Monad's gas limit per transaction. */
export const TX_GAS_LIMIT_CAP = 30_000_000;
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

/** Every hardfork typewriter runs under. */
export const HARDFORKS = [
  "MonadEight",
  "MonadNine",
  "MonadTen",
  "MonadNext",
] as const satisfies readonly Spec[];

/** What one run of `execute`'s scheduler check costs. */
export type SchedulerCheckGas = {
  /**
   * With every storage slot it reads cold, as in revm's run of one
   * execution alone: `warm` plus a cold read per slot, or per page under
   * MIP-8, that it touches.
   */
  cold: number;
  /**
   * With its storage warm, as in a settlement, whose access list lists every
   * slot its executions touched, the check's among them.
   */
  warm: number;
};

/**
 * What `execute`'s scheduler credential check costs, its digest included,
 * under each hardfork: on the fast path, where the credential's address sends
 * the call without a signature, and on the secp256k1 path, where the relayer
 * sends it with the scheduler's 65-byte signature, which adds `ecrecover` and
 * copying the signature. The larger of the root's credential (0) and an
 * executor's after it (1). Measured in revm by `scheduler-gas.test.ts`, which
 * fails when these drift.
 *
 * Each execution's own run takes the fast path with its storage cold. The
 * access list's savings take back the cold reads of every slot it touched,
 * the check's included, so an execution's own check costs `sender.warm` on
 * top. A settlement runs the check once, warm, on the path its relayer takes.
 */
export const SCHEDULER_AUTHORIZATION_GAS: Record<
  Spec,
  { sender: SchedulerCheckGas; signature: SchedulerCheckGas }
> = {
  MonadEight: {
    sender: { cold: 35_940, warm: 3_940 },
    signature: { cold: 43_730, warm: 11_730 },
  },
  MonadNine: {
    sender: { cold: 35_908, warm: 3_908 },
    signature: { cold: 43_674, warm: 11_674 },
  },
  MonadTen: {
    sender: { cold: 27_908, warm: 3_908 },
    signature: { cold: 35_674, warm: 11_674 },
  },
  MonadNext: {
    sender: { cold: 27_908, warm: 3_908 },
    signature: { cold: 35_674, warm: 11_674 },
  },
};

/**
 * The EIP-7623 tokens that a 65-byte signature, every byte nonzero, adds to
 * `execute`'s calldata over an empty one: its length word's nonzero byte,
 * 65 bytes, and the 31 zero bytes that pad it to a word.
 */
export const SIGNATURE_CALLDATA_TOKENS = 3 + 65 * 4 + 31;

/** Calldata costs this much per token below the EIP-7623 floor. */
const STANDARD_GAS_PER_TOKEN = 4;

/**
 * What a settlement's scheduler check costs under `spec`, its signature's
 * calldata included.
 */
const checkGas = (spec: Spec, signed: boolean) =>
  signed
    ? SCHEDULER_AUTHORIZATION_GAS[spec].signature.warm +
      STANDARD_GAS_PER_TOKEN * SIGNATURE_CALLDATA_TOKENS
    : SCHEDULER_AUTHORIZATION_GAS[spec].sender.warm;

/**
 * The most gas an execution can use under `spec`, so that a settlement of it
 * alone, with its scheduler signature, has a gas limit under the cap: a lone
 * execution's settlement charges at most its gas plus the signed check over
 * its own, and its limit adds 1/64, rounded up, and the SSTORE sentry. The
 * signed check also covers the floor's 10 gas per signature token.
 */
export function settlementGas(spec: Spec): number {
  return (
    Math.floor(((TX_GAS_LIMIT_CAP - SSTORE_SENTRY_GAS - 1) * 64) / 65) -
    (checkGas(spec, true) - SCHEDULER_AUTHORIZATION_GAS[spec].sender.warm)
  );
}

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
    { address: Address.Address; slots: Map<bigint, bigint> }
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

/** A settlement under `spec` with no executions yet, with a signature if `signed`. */
const emptyEstimate = (spec: Spec, signed: boolean): Estimate => ({
  gas: TRANSACTION_BASE_GAS + checkGas(spec, signed),
  tokens: signed ? SIGNATURE_CALLDATA_TOKENS : 0,
  addresses: new Set(),
  keys: new Set(),
  writes: new Set(),
});

function addExecution(
  spec: Spec,
  estimate: Estimate,
  { executeResult, calldata }: Execution,
) {
  // Its own run checked the scheduler credential, warm once the access list
  // takes back its cold reads, which the settlement checks once.
  estimate.gas +=
    executeResult.gas_used -
    TRANSACTION_BASE_GAS -
    SCHEDULER_AUTHORIZATION_GAS[spec].sender.warm;
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
 * the cap. `signed` is whether each settlement carries the scheduler's
 * signature, because the relayer isn't the scheduler.
 *
 * @dev Settlements are not capped in bytes.
 */
export function groupByGas<item extends Execution>(
  spec: Spec,
  items: readonly item[],
  signed: boolean,
): item[][] {
  const groups: item[][] = [];
  let estimate = emptyEstimate(spec, signed);
  for (const item of items) {
    addExecution(spec, estimate, item);
    if (groups.length === 0 || limitOf(estimate) > TX_GAS_LIMIT_CAP) {
      groups.push([]);
      estimate = emptyEstimate(spec, signed);
      addExecution(spec, estimate, item);
    }
    groups.at(-1)!.push(item);
  }
  return groups;
}

/**
 * The gas limit of `executions` as one transaction under `spec`, signed with
 * their `accessList`, and with the scheduler's signature if `signed`.
 */
export function gasLimit(
  spec: Spec,
  executions: readonly Execution[],
  signed: boolean,
): number {
  const estimate = emptyEstimate(spec, signed);
  for (const execution of executions) addExecution(spec, estimate, execution);
  return limitOf(estimate);
}
