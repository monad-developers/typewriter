import {
  baseToQuote,
  priceToQ32,
  q32ToPrice,
  TokenAmount,
} from "order-book-sdk";
import { INSTRUMENTS } from "../src/constants";
import { createAccount, deposit, fetchState, limitOrder } from "../src/sdk";

const BPS_LEVELS = [1, 5, 10, 25];

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

const account = await createAccount();
console.log(`account ${account.address}`);

const state = await fetchState();
const book = state.instruments[instrument.id]!;

let midPrice: number;

if (process.env.PRICE) {
  midPrice = Number(process.env.PRICE);
} else {
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
    midQ32 = (bestBid + bestAsk) / 2;
  } else if (bestBid !== null) {
    midQ32 = bestBid;
  } else if (bestAsk !== null) {
    midQ32 = bestAsk;
  }

  if (midQ32 === null) {
    console.error("no existing liquidity, provide a PRICE env var as anchor");
    process.exit(1);
  }

  midPrice = q32ToPrice(BigInt(Math.round(midQ32)), instrument);
}
console.log(`mid price: $${midPrice.toFixed(4)}`);

function isPartiallyFilled(q32Price: bigint, side: "buy" | "sell"): boolean {
  const ticks = side === "buy" ? book.bids : book.asks;
  const tick = ticks[Number(q32Price)];
  if (!tick) return false;
  return BigInt(tick.remainingQuantity) !== BigInt(tick.quantity);
}

const orders: { price: number; side: "buy" | "sell" }[] = [];
for (const bps of BPS_LEVELS) {
  const buyPrice = midPrice * (1 - bps / 10000);
  const sellPrice = midPrice * (1 + bps / 10000);
  if (!isPartiallyFilled(priceToQ32(buyPrice, instrument), "buy")) {
    orders.push({ price: buyPrice, side: "buy" });
  } else {
    console.log(`skipping buy @ $${buyPrice.toFixed(4)} (partially filled tick)`);
  }
  if (!isPartiallyFilled(priceToQ32(sellPrice, instrument), "sell")) {
    orders.push({ price: sellPrice, side: "sell" });
  } else {
    console.log(`skipping sell @ $${sellPrice.toFixed(4)} (partially filled tick)`);
  }
}

let totalBaseDeposit = 0n;
let totalQuoteDeposit = 0n;

for (const order of orders) {
  const quantity = TokenAmount.from(humanQuantity, instrument.base);
  if (order.side === "buy") {
    const q32Price = priceToQ32(order.price, instrument);
    totalQuoteDeposit += baseToQuote(quantity, q32Price, instrument).raw;
  } else {
    totalBaseDeposit += quantity.raw;
  }
}

if (totalBaseDeposit > 0n) {
  const baseAmount = TokenAmount.fromRaw(totalBaseDeposit, instrument.base);
  console.log(`depositing ${baseAmount.human.toFixed(4)} base...`);
  await deposit(account, { quantity: baseAmount });
}
if (totalQuoteDeposit > 0n) {
  const quoteAmount = TokenAmount.fromRaw(totalQuoteDeposit, instrument.quote);
  console.log(`depositing ${quoteAmount.human.toFixed(4)} quote...`);
  await deposit(account, { quantity: quoteAmount });
}

for (const order of orders) {
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

console.log(`placed ${orders.length} orders around $${midPrice.toFixed(4)}`);
