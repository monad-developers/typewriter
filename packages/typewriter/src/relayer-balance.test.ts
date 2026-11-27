import { expect, test } from "bun:test";
import type { Hex } from "ox";
import { makeRelayerLedger, maxSettlementCost } from "./relayer-balance";
import { MAX_PRIORITY_FEE_PER_GAS } from "./typewriter-constants";

const BLOCK = (number: bigint) => ({
  number,
  hash: `0x${number.toString(16).padStart(64, "0")}` as Hex.Hex,
});

test("the relayer ledger expects the balance less the fees of settlements up to the final block", () => {
  const ledger = makeRelayerLedger({ balance: 1_000n, number: 10n });
  ledger.landed(BLOCK(11n), 30n);
  ledger.landed(BLOCK(12n), 20n);
  ledger.landed(BLOCK(14n), 50n);

  // Block 14 isn't final yet.
  expect(ledger.reconcile(950n, 12n)).toEqual({
    expected: 950n,
    spent: 50n,
    difference: 0n,
  });
  // A reorg removed block 14; its settlement lands again in 15.
  ledger.removed(BLOCK(14n).hash);
  ledger.landed(BLOCK(15n), 50n);
  // A top-up of 100 since.
  expect(ledger.reconcile(1_000n, 15n)).toEqual({
    expected: 900n,
    spent: 50n,
    difference: 100n,
  });
  // Something else spent 7.
  expect(ledger.reconcile(993n, 16n).difference).toBe(-7n);
  expect(ledger.averageFee()).toBe((30n + 20n + 50n + 50n) / 4n);
});

test("a settlement of the most gas costs 30M gas at the base fee and the tip", () => {
  expect(maxSettlementCost(100_000_000_000n)).toBe(
    30_000_000n * (100_000_000_000n + MAX_PRIORITY_FEE_PER_GAS),
  );
});
