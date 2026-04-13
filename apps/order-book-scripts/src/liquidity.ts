import { INSTRUMENTS } from "./constants";
import { createAccount, deposit, limitOrder, priceToQ32, TokenAmount } from "./sdk";

if (!process.env.PRICE) {
  console.error("PRICE env var is required (e.g. 2400 for $2400)");
  process.exit(1);
}
if (!process.env.SIDE) {
  console.error("SIDE env var is required (buy or sell)");
  process.exit(1);
}

const instrumentName = (process.env.INSTRUMENT ??
  "GOLD/USD") as keyof typeof INSTRUMENTS;
const inst = INSTRUMENTS[instrumentName];
if (!inst) {
  console.error(`unknown instrument: ${instrumentName}`);
  process.exit(1);
}

const inputPrice = Number(process.env.PRICE);
const side = process.env.SIDE as "buy" | "sell";
const humanQuantity = Number(process.env.QUANTITY ?? "1");

const account = await createAccount();
console.log(`account ${account.address}`);

const amount = TokenAmount.from(humanQuantity, inst, "base");
console.log(`amount: ${amount.human} (${amount.lots} lots)`);

if (side === "sell") {
  console.log(`minting ${amount.human} base (${inst.base})...`);
  await deposit(account, amount);
} else {
  const q32Price = priceToQ32(inputPrice, inst);
  const quoteLots = (amount.lots * q32Price) >> 32n;
  const rawQuote = (quoteLots + 1n) << BigInt(inst.quoteLotExp);
  const quoteCost = TokenAmount.fromRaw(rawQuote, inst, "quote");
  console.log(`minting ${quoteCost.human} quote (${inst.quote})...`);
  await deposit(account, quoteCost);
}

console.log(`placing ${side}: ${amount.human} @ $${inputPrice}...`);
await limitOrder(account, { amount, price: inputPrice, side });

console.log("done");
