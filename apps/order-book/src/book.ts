import type { Side } from "order-book-sdk";
import type { Hex } from "viem";
import { app } from "./app";

const DEPTH_BPS = [1n, 5n, 25n];

function at<value>(mapping: Record<`${number}`, value>, key: bigint): value {
  return mapping[`${key}` as `${number}`];
}

function ticks(instrumentId: bigint, side: Side) {
  return at(app.state.instruments, instrumentId)[
    side === "buy" ? "bids" : "asks"
  ];
}

/** Price levels with quantity left on one side of the book, best first. */
function levels(instrumentId: bigint, side: Side) {
  const instrument = at(app.state.instruments, instrumentId);
  const out: { price: bigint; quantity: bigint }[] = [];
  let price = side === "buy" ? instrument.bestBid : instrument.bestAsk;
  while (price !== 0n) {
    const tick = at(ticks(instrumentId, side), price);
    if (tick.remainingQuantity > 0n) {
      out.push({ price, quantity: tick.remainingQuantity });
    }
    price = tick.next;
  }
  return out;
}

function book(instrumentId: bigint) {
  const bids = levels(instrumentId, "buy");
  const asks = levels(instrumentId, "sell");
  const bestBid = bids[0]?.price ?? null;
  const bestAsk = asks[0]?.price ?? null;
  const mid =
    bestBid !== null && bestAsk !== null
      ? (bestBid + bestAsk) / 2n
      : (bestBid ?? bestAsk);
  return { bids, asks, bestBid, bestAsk, mid };
}

export function price(instrumentId: bigint) {
  const { bestBid, bestAsk, mid } = book(instrumentId);
  return {
    price: mid,
    bestBid,
    bestAsk,
    spread: bestBid !== null && bestAsk !== null ? bestAsk - bestBid : null,
  };
}

/** The quantity resting within each of `DEPTH_BPS` of the mid price. */
export function depth(instrumentId: bigint) {
  const { bids, asks, mid } = book(instrumentId);
  const totals = (
    levels: { price: bigint; quantity: bigint }[],
    within: (price: bigint, mid: bigint, bps: bigint) => boolean,
  ) =>
    Object.fromEntries(
      DEPTH_BPS.map((bps) => [
        `${bps}`,
        levels.reduce(
          (sum, level) =>
            mid !== null && within(level.price, mid, bps)
              ? sum + level.quantity
              : sum,
          0n,
        ),
      ]),
    );
  return {
    bids: totals(
      bids,
      (price, mid, bps) => price * 10_000n >= mid * (10_000n - bps),
    ),
    asks: totals(
      asks,
      (price, mid, bps) => price * 10_000n <= mid * (10_000n + bps),
    ),
  };
}

export function tickAt(instrumentId: bigint, side: Side, price: bigint) {
  const { quantity, remainingQuantity, volume } = at(
    ticks(instrumentId, side),
    price,
  );
  if (quantity === 0n && remainingQuantity === 0n && volume === 0) return null;
  return { quantity, remainingQuantity, volume };
}

/** The fills a market order for `quantity` would get, or `null` if too few. */
export function estimateMarketOrder(
  instrumentId: bigint,
  side: Side,
  quantity: bigint,
) {
  let remaining = quantity;
  let quoteQuantity = 0n;
  const fills: { quantity: bigint; price: bigint }[] = [];
  for (const level of levels(instrumentId, side === "buy" ? "sell" : "buy")) {
    if (remaining === 0n) break;
    const fill = remaining < level.quantity ? remaining : level.quantity;
    quoteQuantity += (fill * level.price) >> 32n;
    remaining -= fill;
    fills.push({ quantity: fill, price: level.price });
  }
  if (remaining > 0n) return null;
  return { fills, filledQuantity: quantity, quoteQuantity };
}

/** The fills a market order would get from every level up to `limit`. */
export function estimateFillToPrice(
  instrumentId: bigint,
  side: Side,
  limit: bigint,
) {
  let totalQuantity = 0n;
  let quoteQuantity = 0n;
  const fills: { quantity: bigint; price: bigint }[] = [];
  for (const level of levels(instrumentId, side === "buy" ? "sell" : "buy")) {
    if (side === "buy" ? level.price > limit : level.price < limit) break;
    totalQuantity += level.quantity;
    quoteQuantity += (level.quantity * level.price) >> 32n;
    fills.push({ quantity: level.quantity, price: level.price });
  }
  return { fills, totalQuantity, quoteQuantity };
}

export function accountExists(accountID: Hex): boolean {
  return app.accounts[accountID].credentials.length > 0;
}

export function accountCredentials(accountID: Hex) {
  const credentials = app.accounts[accountID].credentials;
  return Array.from({ length: credentials.length }, (_, index) => ({
    ...credentials[index],
  }));
}

export function accountBalances(accountID: Hex) {
  return { ...app.state.accounts[accountID].balances };
}

export function accountOrders(accountID: Hex, instrumentId?: bigint) {
  const orders = app.state.accounts[accountID].orders;
  return Array.from({ length: orders.length }, (_, orderId) => ({
    orderId,
    ...orders[orderId],
  })).filter(
    (order) =>
      instrumentId === undefined || order.instrumentId === instrumentId,
  );
}
