import {
  baseToQuote,
  priceToQ32,
  q32ToPrice,
  TokenAmount,
} from "order-book-sdk";
import {
  createAccount,
  deposit,
  fetchPrice,
  fetchTicks,
  limitOrder,
} from "./src/client";
import { instrumentEnv, requiredEnv } from "./src/env";

const BPS_LEVELS = [1, 5, 10, 25];

const humanQuantity = Number(requiredEnv("QUANTITY", "1 for 1 unit per level"));
const { instrument } = instrumentEnv();

const account = await createAccount();
console.log(`account ${account.accountID}`);

let midPrice: number;
if (process.env.PRICE) {
  midPrice = Number(process.env.PRICE);
} else {
  const { price } = await fetchPrice(instrument.id);
  if (price === null) {
    console.error("no existing liquidity, provide a PRICE env var as anchor");
    process.exit(1);
  }
  midPrice = q32ToPrice(price, instrument);
}
console.log(`mid price: $${midPrice.toFixed(4)}`);

const candidates = BPS_LEVELS.flatMap((bps) => [
  {
    bps,
    side: "buy" as const,
    price: midPrice * (1 - bps / 10000),
  },
  {
    bps,
    side: "sell" as const,
    price: midPrice * (1 + bps / 10000),
  },
]);
const tickResults = await fetchTicks(
  instrument.id,
  candidates.map((c) => ({
    side: c.side,
    priceQ32: priceToQ32(c.price, instrument),
  })),
);

const orders: { price: number; side: "buy" | "sell" }[] = [];
for (let i = 0; i < candidates.length; i++) {
  const c = candidates[i]!;
  const tick = tickResults[i];
  const partiallyFilled =
    tick !== null &&
    tick !== undefined &&
    tick.remainingQuantity !== tick.quantity;
  if (!partiallyFilled) {
    orders.push({ price: c.price, side: c.side });
  } else {
    console.log(
      `skipping ${c.side} @ $${c.price.toFixed(4)} (partially filled tick)`,
    );
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
