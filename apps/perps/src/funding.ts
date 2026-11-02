import { admin } from "./admin";
import { marketIds, marketSummary } from "./read";

const FUNDING_PERIOD_MS = 8 * 60 * 60 * 1000;
/** The premium is clamped to ±0.5% per funding period. */
const MAX_PREMIUM_PPM = 5_000n;

let lastAccrual = Date.now();

function clamp(value: bigint, bound: bigint) {
  return value > bound ? bound : value < -bound ? -bound : value;
}

/**
 * Funding per lot for the time since the last accrual: the book's premium
 * over the oracle, scaled from an 8 hour period. Markets without a two-sided
 * book pay nothing.
 */
function fundings(elapsedMs: number) {
  return marketIds().flatMap((marketId) => {
    const { mid, oraclePrice } = marketSummary(marketId);
    if (mid === null) return [];
    const premiumPpm = clamp(
      ((mid - oraclePrice) * 1_000_000n) / oraclePrice,
      MAX_PREMIUM_PPM,
    );
    const fundingPerLot =
      (oraclePrice * premiumPpm * BigInt(elapsedMs)) /
      (1_000_000n * BigInt(FUNDING_PERIOD_MS));
    return fundingPerLot === 0n ? [] : [{ marketId, fundingPerLot }];
  });
}

export function startFunding(intervalMs: number) {
  lastAccrual = Date.now();
  return setInterval(async () => {
    const now = Date.now();
    const pending = fundings(now - lastAccrual);
    if (pending.length === 0) return;
    try {
      await admin.execute("AccrueFunding", { fundings: pending });
      lastAccrual = now;
    } catch (error) {
      console.error("funding accrual rejected", error);
    }
  }, intervalMs);
}
