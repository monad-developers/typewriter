import type { Hex } from "viem";
import { app } from "./app";

const BPS = 10_000n;

function at<value>(mapping: Record<`${number}`, value>, key: bigint): value {
  return mapping[`${key}` as `${number}`];
}

function abs(value: bigint) {
  return value < 0n ? -value : value;
}

function max(a: bigint, b: bigint) {
  return a > b ? a : b;
}

export function marketIds(): bigint[] {
  const ids = app.state.marketIds;
  return Array.from({ length: ids.length }, (_, index) => ids[index]!);
}

function market(marketId: bigint) {
  return at(app.state.markets, marketId);
}

export function marketExists(marketId: bigint) {
  return market(marketId).listed;
}

export function marketSummary(marketId: bigint) {
  const m = market(marketId);
  const bestBid = m.bestBid === 0n ? null : m.bestBid;
  const bestAsk = m.bestAsk === 0n ? null : m.bestAsk;
  return {
    marketId,
    status: m.status,
    oraclePrice: m.oraclePrice,
    bestBid,
    bestAsk,
    mid: bestBid !== null && bestAsk !== null ? (bestBid + bestAsk) / 2n : null,
    openInterest: m.openInterest,
    cumulativeFunding: m.cumulativeFunding,
    tickSize: m.tickSize,
    initialMarginBps: m.initialMarginBps,
    maintenanceMarginBps: m.maintenanceMarginBps,
    takerFeeBps: m.takerFeeBps,
    liquidationFeeBps: m.liquidationFeeBps,
  };
}

/** Price levels on one side of the book, best first. */
export function levels(marketId: bigint, side: "buy" | "sell", limit = 20) {
  const m = market(marketId);
  const book = side === "buy" ? m.bids : m.asks;
  const out: { price: bigint; quantity: bigint }[] = [];
  let price = side === "buy" ? m.bestBid : m.bestAsk;
  while (price !== 0n && out.length < limit) {
    const level = at(book, price);
    out.push({ price, quantity: level.quantity });
    price = level.next;
  }
  return out;
}

export function accountExists(accountID: Hex): boolean {
  return app.accounts[accountID].credentials.length > 0;
}

/** Accounts any accepted mutation has touched in `state.accounts`. */
export function knownAccounts(): Hex[] {
  return Object.keys(app.state.accounts) as Hex[];
}

function accountMarketIds(accountID: Hex): bigint[] {
  const ids = app.state.accounts[accountID].marketIds;
  return Array.from({ length: ids.length }, (_, index) => ids[index]!);
}

function position(accountID: Hex, marketId: bigint) {
  const p = at(app.state.accounts[accountID].positions, marketId);
  const m = market(marketId);
  const size = p.size;
  const unrealizedPnl = size * m.oraclePrice - p.cost;
  const fundingOwed = size * (m.cumulativeFunding - p.fundingIndex);
  const worstCaseSize = max(abs(size + p.bidLots), abs(size - p.askLots));
  return {
    marketId,
    size,
    cost: p.cost,
    entryPrice: size === 0n ? null : p.cost / size,
    markPrice: m.oraclePrice,
    unrealizedPnl,
    fundingOwed,
    bidLots: p.bidLots,
    askLots: p.askLots,
    initialMargin:
      (worstCaseSize * m.oraclePrice * BigInt(m.initialMarginBps)) / BPS,
    maintenanceMargin:
      (abs(size) * m.oraclePrice * BigInt(m.maintenanceMarginBps)) / BPS,
  };
}

/** Mirrors `health` in Margin.sol. */
export function health(accountID: Hex) {
  const positions = accountMarketIds(accountID).map((marketId) =>
    position(accountID, marketId),
  );
  const collateral = app.state.accounts[accountID].collateral;
  let equity = collateral;
  let initialMargin = 0n;
  let maintenanceMargin = 0n;
  for (const p of positions) {
    equity += p.unrealizedPnl - p.fundingOwed;
    initialMargin += p.initialMargin;
    maintenanceMargin += p.maintenanceMargin;
  }
  return {
    collateral,
    equity,
    initialMargin,
    maintenanceMargin,
    freeCollateral: equity - initialMargin,
    liquidatable: equity < maintenanceMargin,
    positions,
  };
}

export function accountOrders(accountID: Hex) {
  return accountMarketIds(accountID).flatMap((marketId) => {
    const orderIds = at(
      app.state.accounts[accountID].positions,
      marketId,
    ).orderIds;
    return Array.from({ length: orderIds.length }, (_, index) => {
      const orderId = orderIds[index]!;
      const order = at(app.state.orders, orderId);
      return {
        orderId,
        marketId,
        side: order.side === 0 ? "buy" : "sell",
        price: order.price,
        quantity: order.quantity,
      };
    });
  });
}

export function accountSummary(accountID: Hex) {
  return {
    accountID,
    ...health(accountID),
    orders: accountOrders(accountID),
  };
}

export function exchangeSummary() {
  return {
    admin: app.state.admin,
    insuranceFund: app.state.insuranceFund,
    lastOrderId: app.state.lastOrderId,
    markets: marketIds().map(marketSummary),
  };
}
