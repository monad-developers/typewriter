import type { Hex } from "viem";
import { admin } from "./admin";
import { app } from "./app";
import { health, knownAccounts } from "./read";

/** How far past the oracle price a liquidation may fill. */
const SLIPPAGE_BPS = 1_000n;
/** How long to leave an account alone after its liquidation is rejected. */
const RETRY_AFTER_MS = 5_000;
const HISTORY_LIMIT = 50;

type Liquidation = {
  account: Hex;
  marketId: bigint;
  quantity: bigint;
  limitPrice: bigint;
  at: number;
} & (
  | { status: "accepted"; executionIndex: bigint }
  | { status: "rejected"; error: string }
);

const inFlight = new Set<Hex>();
const retryAt = new Map<Hex, number>();
let history: Liquidation[] = [];

export function recentLiquidations() {
  return history;
}

function record(liquidation: Liquidation) {
  history = [liquidation, ...history].slice(0, HISTORY_LIMIT);
}

/**
 * Liquidates the account's largest position, one `Liquidate` at a time, until
 * it is back above maintenance margin.
 */
async function liquidate(account: Hex) {
  inFlight.add(account);
  try {
    while (true) {
      const { liquidatable, positions } = health(account);
      if (!liquidatable) return;
      const largest = positions
        .filter((p) => p.size !== 0n)
        .sort((a, b) =>
          a.maintenanceMargin > b.maintenanceMargin ? -1 : 1,
        )[0];
      if (largest === undefined) return;

      const selling = largest.size > 0n;
      const params = {
        account,
        marketId: largest.marketId,
        quantity: selling ? largest.size : -largest.size,
        limitPrice:
          (largest.markPrice *
            (selling ? 10_000n - SLIPPAGE_BPS : 10_000n + SLIPPAGE_BPS)) /
          10_000n,
      };
      try {
        const { executionIndex } = await admin.execute("Liquidate", params);
        record({
          ...params,
          at: Date.now(),
          status: "accepted",
          executionIndex,
        });
      } catch (error) {
        record({
          ...params,
          at: Date.now(),
          status: "rejected",
          error: error instanceof Error ? error.message : String(error),
        });
        retryAt.set(account, Date.now() + RETRY_AFTER_MS);
        return;
      }
    }
  } finally {
    inFlight.delete(account);
  }
}

/** Starts a liquidation for every account below maintenance margin. */
export function scan() {
  const now = Date.now();
  for (const account of knownAccounts()) {
    if (inFlight.has(account) || (retryAt.get(account) ?? 0) > now) continue;
    if (!health(account).liquidatable) continue;
    retryAt.delete(account);
    void liquidate(account);
  }
}

/** Rescans after every accepted batch, since any batch can move health. */
export function startLiquidator() {
  return app.on("batch", (batch) => {
    if (batch.status === "accepted") scan();
  });
}
