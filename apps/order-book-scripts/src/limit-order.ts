import { baseToQuote, priceToQ32, TokenAmount } from "order-book-sdk";
import { INSTRUMENTS } from "./constants";
import { createAccount, deposit, limitOrder } from "./sdk";

if (!process.env.PRICE) {
  console.error("PRICE env var is required (e.g. 2400 for $2400)");
  process.exit(1);
}
if (!process.env.SIDE) {
  console.error("SIDE env var is required (buy or sell)");
  process.exit(1);
}
if (!process.env.QUANTITY) {
  console.error("QUANTITY env var is required (e.g. 1 for 1 unit)");
  process.exit(1);
}
if (!process.env.INSTRUMENT) {
  console.error(
    "INSTRUMENT env var is required (e.g. GOLD/USD, or see constants.ts for options)",
  );
  process.exit(1);
}

const price = Number(process.env.PRICE);
const side = process.env.SIDE as "buy" | "sell";
if (side !== "buy" && side !== "sell") {
  console.error("SIDE env var must be 'buy' or 'sell'");
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

const quantity = TokenAmount.from(humanQuantity, instrument.base);
console.log(
  `amount: ${quantity.human} (raw: ${quantity.raw}, asset: ${quantity.asset})`,
);
if (side === "buy") {
  // quote
  await deposit(account, {
    quantity: baseToQuote(quantity, priceToQ32(price, instrument), instrument),
  });
} else {
  // base
  await deposit(account, { quantity });
}

console.log(`placing ${side}: ${quantity.human} @ $${price}...`);
await limitOrder(account, { instrument, quantity, price, side });
console.log("done");
