import type { Hex } from "ox";
import { MAX_PRIORITY_FEE_PER_GAS } from "./typewriter-constants";

/** Monad's gas limit per transaction, the most one settlement can use. */
const MAX_SETTLEMENT_GAS = 30_000_000n;

/** How many recent settlements the runway's average fee is over. */
const RECENT_FEES = 100;

/**
 * What a settlement of the most gas costs at `baseFee` and the runtime's tip,
 * which Monad checks the sender's balance against.
 */
export function maxSettlementCost(baseFee: bigint): bigint {
  return MAX_SETTLEMENT_GAS * (baseFee + MAX_PRIORITY_FEE_PER_GAS);
}

export type Reconciliation = {
  /** The balance the relayer's own settlements leave it, since the last. */
  expected: bigint;
  /** What its settlements paid since the last. */
  spent: bigint;
  /** `actual - expected`: positive for a top-up, negative for foreign spend. */
  difference: bigint;
};

/**
 * The relayer's balance as its own settlements change it. The runtime is the
 * key's only sender, so each settlement that lands, reverted or not, takes
 * its fee, `gasUsed * effectiveGasPrice`, and nothing else does. A balance
 * read at a final block checks it: higher is a top-up, lower is a spend by
 * something else.
 */
export function makeRelayerLedger(start: { balance: bigint; number: bigint }) {
  let reconciled = start;
  /** The fees of landed settlements after `reconciled`, by block hash. */
  let landed: { number: bigint; hash: Hex.Hex; fee: bigint }[] = [];
  const recentFees: bigint[] = [];

  return {
    /** Records the fee of a settlement that landed in a block. */
    landed(block: { number: bigint; hash: Hex.Hex }, fee: bigint) {
      landed.push({ number: block.number, hash: block.hash, fee });
      recentFees.push(fee);
      if (recentFees.length > RECENT_FEES) recentFees.shift();
    },
    /** Forgets the fees in a block that a reorg removed. */
    removed(hash: Hex.Hex) {
      landed = landed.filter((entry) => entry.hash !== hash);
    },
    /**
     * Compares `balance`, read at the final block `number`, with what the
     * settlements up to it left, and starts the next comparison from it.
     */
    reconcile(balance: bigint, number: bigint): Reconciliation {
      let spent = 0n;
      for (const entry of landed) {
        if (entry.number > reconciled.number && entry.number <= number) {
          spent += entry.fee;
        }
      }
      const expected = reconciled.balance - spent;
      landed = landed.filter((entry) => entry.number > number);
      reconciled = { balance, number };
      return { expected, spent, difference: balance - expected };
    },
    /** The average fee of recent settlements, if any landed. */
    averageFee(): bigint | undefined {
      if (recentFees.length === 0) return undefined;
      return (
        recentFees.reduce((sum, fee) => sum + fee, 0n) /
        BigInt(recentFees.length)
      );
    },
  };
}
