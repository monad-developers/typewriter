import { fromLots, q32ToPrice, TokenAmount, toLots } from "order-book-sdk";
import { INSTRUMENTS } from "./constants";
import { createAccount, deposit, fetchState, marketOrder } from "./sdk";

if (!process.env.SIDE) {
  console.error("SIDE env var is required (buy or sell)");
  process.exit(1);
}
if (!process.env.QUANTITY) {
  console.error("QUANTITY env var is required (e.g. 1 for 1 unit of base)");
  process.exit(1);
}
if (!process.env.INSTRUMENT) {
  console.error(
    "INSTRUMENT env var is required (e.g. GOLD/USD, or see constants.ts for options)",
  );
  process.exit(1);
}

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

const state = await fetchState();
const book = state.instruments[instrument.id]!;

const account = await createAccount();
console.log(`account ${account.address}`);

const quantity = TokenAmount.from(humanQuantity, instrument.base);
console.log(
  `amount: ${quantity.human.toFixed(4)} (raw: ${quantity.raw}, asset: ${quantity.asset})`,
);

const ticks = side === "buy" ? book.asks : book.bids;
const prices = Object.keys(ticks)
  .map(Number)
  .filter((p) => BigInt(ticks[p]!.remainingQuantity) > 0n)
  .sort((a, b) => (side === "buy" ? a - b : b - a));

let remainingLots = toLots(quantity.raw, instrument.baseLotExp);
let quoteLots = 0n;

for (const price of prices) {
  if (remainingLots === 0n) break;
  const tick = ticks[price]!;
  const availableLots = BigInt(tick.remainingQuantity);
  const fillLots =
    remainingLots < availableLots ? remainingLots : availableLots;
  quoteLots += (fillLots * BigInt(price)) >> 32n;
  remainingLots -= fillLots;

  console.log(
    `price: $${q32ToPrice(BigInt(price), instrument).toFixed(4)}, fill quantity: ${TokenAmount.fromRaw(fromLots(fillLots, instrument.baseLotExp), instrument.base).human.toFixed(4)}`,
  );
}

if (remainingLots > 0n) {
  console.error(`insufficient liquidity: ${remainingLots} lots unfilled`);
  process.exit(1);
}

const q32 = (quoteLots << 32n) / toLots(quantity.raw, instrument.baseLotExp);
console.log(
  `placing market ${side}: ${quantity.human.toFixed(4)} @~$${q32ToPrice(q32, instrument).toFixed(4)}...`,
);

if (side === "buy") {
  // quote
  await deposit(account, {
    quantity: TokenAmount.fromRaw(
      fromLots(quoteLots, instrument.quoteLotExp),
      instrument.quote,
    ),
  });
} else {
  // base
  await deposit(account, { quantity });
}

await marketOrder(account, {
  instrument,
  quantity,
  side,
  minReceived: TokenAmount.fromRaw(
    side === "buy" ? quantity.raw : fromLots(quoteLots, instrument.quoteLotExp),
    side === "buy" ? instrument.base : instrument.quote,
  ),
});

console.log("done");
