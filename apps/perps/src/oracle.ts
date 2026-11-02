import { admin } from "./admin";
import { marketIds, marketSummary } from "./read";

/** Per-tick standard deviation of the dev feed's log price. */
const VOLATILITY = 0.0005;

/**
 * Collateral units per lot, by market. The dev feed is a random walk from
 * each market's onchain price; a real deployment replaces `nextPrices` with
 * an external feed.
 */
const prices = new Map<bigint, bigint>();
let pushing = false;

function gaussian() {
  return (
    Math.sqrt(-2 * Math.log(1 - Math.random())) *
    Math.cos(2 * Math.PI * Math.random())
  );
}

function nextPrices() {
  for (const marketId of marketIds()) {
    const { oraclePrice, tickSize } = marketSummary(marketId);
    const current = prices.get(marketId) ?? oraclePrice;
    const next = BigInt(
      Math.round(Number(current) * Math.exp(VOLATILITY * gaussian())),
    );
    prices.set(marketId, max((next / tickSize) * tickSize, tickSize));
  }
}

function max(a: bigint, b: bigint) {
  return a > b ? a : b;
}

async function push() {
  if (pushing || prices.size === 0) return;
  pushing = true;
  try {
    await admin.execute("SetOraclePrices", {
      prices: [...prices].map(([marketId, price]) => ({ marketId, price })),
    });
  } catch (error) {
    console.error("oracle update rejected", error);
  } finally {
    pushing = false;
  }
}

export function startOracle(intervalMs: number) {
  return setInterval(() => {
    nextPrices();
    void push();
  }, intervalMs);
}

/** Overrides a market's feed and pushes its price now. */
export function setOraclePrice(marketId: bigint, price: bigint) {
  prices.set(marketId, price);
  return admin.execute("SetOraclePrices", { prices: [{ marketId, price }] });
}
