import type { Instrument, Order } from "order-book-backend/src/exchange";
import {
  baseToQuote,
  priceToQ32,
  q32ToPrice,
  TokenAmount,
} from "order-book-sdk";
import { INSTRUMENTS } from "../src/constants";
import {
  type Account,
  closeOrder,
  createAccount,
  deposit,
  fetchState,
  limitOrder,
} from "../src/sdk";

const RANGES = [
  { min: 0, max: 1 },
  { min: 1, max: 5 },
  { min: 5, max: 10 },
  { min: 10, max: 25 },
  { min: 25, max: 100 },
  { min: 100, max: 250 },
  { min: 250, max: 1000 },
];
const DEFAULT_INTERVAL = 10_000;

if (!process.env.QUANTITY) {
  console.error("QUANTITY env var is required (e.g. 1 for 1 unit per level)");
  process.exit(1);
}
if (!process.env.INSTRUMENT) {
  console.error(
    "INSTRUMENT env var is required (e.g. GOLD/USD, or see constants.ts for options)",
  );
  process.exit(1);
}

const humanQuantity = Number(process.env.QUANTITY);
const instrumentName = process.env.INSTRUMENT as keyof typeof INSTRUMENTS;
const instrument = INSTRUMENTS[instrumentName];
if (!instrument) {
  console.error(`unknown instrument: ${instrumentName}`);
  process.exit(1);
}
const interval = Number(process.env.INTERVAL ?? DEFAULT_INTERVAL);

let account: Awaited<ReturnType<typeof createAccount>>;
while (true) {
  try {
    account = await createAccount();
    break;
  } catch (err) {
    console.error(
      "createAccount failed, retrying:",
      err instanceof Error ? err.message : err,
    );
    await Bun.sleep(interval);
  }
}
console.log(`account ${account.address}`);
console.log(`interval: ${interval}ms`);

while (true) {
  try {
    await tick();
  } catch (err) {
    console.error(
      "iteration failed:",
      err instanceof Error ? err.message : err,
    );
  }
  await Bun.sleep(interval);
}

async function tick() {
  const state = await fetchState();
  const book = state.instruments[instrument.id];
  if (!book) {
    console.log("instrument not found on-chain, skipping");
    return;
  }
  const acc = state.accounts[account.accountHex];
  const orders = acc?.orders ?? [];

  const filledIds = findFilledOrders(orders, book);
  if (filledIds.length > 0) {
    console.log(`closing ${filledIds.length} filled orders...`);
    for (const orderId of filledIds) {
      await closeOrder(account, { orderId });
    }
  }

  const midPrice = getMidPrice(book);
  if (midPrice === null) {
    console.log("no price available, skipping");
    return;
  }
  console.log(`mid price: $${midPrice.toFixed(4)}`);

  const covered = getCoveredRanges(orders, book, midPrice);
  const needed = getMissingOrders(midPrice, covered, book);

  if (needed.length === 0) {
    console.log("all ranges covered");
    return;
  }

  await depositForOrders(account, needed);

  for (const order of needed) {
    const quantity = TokenAmount.from(humanQuantity, instrument.base);
    console.log(
      `placing ${order.side}: ${quantity.human} @ $${order.price.toFixed(4)}`,
    );
    await limitOrder(account, {
      instrument,
      quantity,
      price: order.price,
      side: order.side,
    });
  }

  console.log(`placed ${needed.length} orders`);
}

function getMidPrice(book: Instrument): number | null {
  const bidPrices = Object.keys(book.bids)
    .map(Number)
    .filter((p) => BigInt(book.bids[p]!.remainingQuantity) > 0n);
  const askPrices = Object.keys(book.asks)
    .map(Number)
    .filter((p) => BigInt(book.asks[p]!.remainingQuantity) > 0n);
  const bestBid = bidPrices.length > 0 ? Math.max(...bidPrices) : null;
  const bestAsk = askPrices.length > 0 ? Math.min(...askPrices) : null;

  let midQ32: number | null = null;
  if (bestBid !== null && bestAsk !== null) {
    midQ32 = Math.round((bestBid + bestAsk) / 2);
  } else if (bestBid !== null) {
    midQ32 = bestBid;
  } else if (bestAsk !== null) {
    midQ32 = bestAsk;
  }

  if (midQ32 === null) return null;
  return q32ToPrice(BigInt(midQ32), instrument);
}

function orderBps(order: Order, midPrice: number): number {
  const price = q32ToPrice(BigInt(order.price), instrument);
  return (Math.abs(price - midPrice) / midPrice) * 10000;
}

function rangeKey(side: "buy" | "sell", rangeIndex: number): string {
  return `${side}:${rangeIndex}`;
}

function findRangeIndex(bps: number): number | null {
  for (let i = 0; i < RANGES.length; i++) {
    if (bps >= RANGES[i]!.min && bps < RANGES[i]!.max) return i;
  }
  return null;
}

function getCoveredRanges(
  orders: Order[],
  book: Instrument,
  midPrice: number,
): Set<string> {
  const covered = new Set<string>();
  for (let i = 0; i < orders.length; i++) {
    const order = orders[i]!;
    if (order.quantity === "0") continue;
    if (order.instrumentId !== instrument.id) continue;

    const ticks = order.side === 0 ? book.bids : book.asks;
    const tick = ticks[Number(order.price)];
    if (!tick || tick.volume > order.tickVolume) continue;

    const bps = orderBps(order, midPrice);
    const ri = findRangeIndex(bps);
    if (ri === null) continue;

    const side = order.side === 0 ? "buy" : "sell";
    covered.add(rangeKey(side, ri));
  }
  return covered;
}

function isPartiallyFilled(
  book: Instrument,
  q32Price: bigint,
  side: "buy" | "sell",
): boolean {
  const ticks = side === "buy" ? book.bids : book.asks;
  const tick = ticks[Number(q32Price)];
  if (!tick) return false;
  return BigInt(tick.remainingQuantity) !== BigInt(tick.quantity);
}

function getMissingOrders(
  midPrice: number,
  covered: Set<string>,
  book: Instrument,
): { price: number; side: "buy" | "sell" }[] {
  const orders: { price: number; side: "buy" | "sell" }[] = [];

  for (let i = 0; i < RANGES.length; i++) {
    const range = RANGES[i]!;
    const midBps = (range.min + range.max) / 2;

    if (!covered.has(rangeKey("buy", i))) {
      const price = midPrice * (1 - midBps / 10000);
      if (!isPartiallyFilled(book, priceToQ32(price, instrument), "buy")) {
        orders.push({ price, side: "buy" });
      }
    }

    if (!covered.has(rangeKey("sell", i))) {
      const price = midPrice * (1 + midBps / 10000);
      if (!isPartiallyFilled(book, priceToQ32(price, instrument), "sell")) {
        orders.push({ price, side: "sell" });
      }
    }
  }

  return orders;
}

function findFilledOrders(orders: Order[], book: Instrument): number[] {
  const filled: number[] = [];
  for (let i = 0; i < orders.length; i++) {
    const order = orders[i]!;
    if (order.quantity === "0") continue;
    if (order.instrumentId !== instrument.id) continue;

    const ticks = order.side === 0 ? book.bids : book.asks;
    const tick = ticks[Number(order.price)];
    if (!tick || tick.volume > order.tickVolume) {
      filled.push(i);
    }
  }
  return filled;
}

async function depositForOrders(
  account: Account,
  orders: { price: number; side: "buy" | "sell" }[],
) {
  let totalBase = 0n;
  let totalQuote = 0n;

  for (const order of orders) {
    const quantity = TokenAmount.from(humanQuantity, instrument.base);
    if (order.side === "buy") {
      totalQuote += baseToQuote(
        quantity,
        priceToQ32(order.price, instrument),
        instrument,
      ).raw;
    } else {
      totalBase += quantity.raw;
    }
  }

  if (totalBase > 0n) {
    const amount = TokenAmount.fromRaw(totalBase, instrument.base);
    console.log(`depositing ${amount.human.toFixed(4)} base...`);
    await deposit(account, { quantity: amount });
  }
  if (totalQuote > 0n) {
    const amount = TokenAmount.fromRaw(totalQuote, instrument.quote);
    console.log(`depositing ${amount.human.toFixed(4)} quote...`);
    await deposit(account, { quantity: amount });
  }
}
