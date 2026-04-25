import { fromLots, priceToQ32, q32ToPrice, TokenAmount } from "order-book-sdk";
import { INSTRUMENTS } from "../src/constants";
import { createAccount, deposit, fetchState, marketOrder } from "../src/sdk";

if (!process.env.PRICE) {
  console.error("PRICE env var is required (e.g. 2400 for $2400)");
  process.exit(1);
}
if (!process.env.INSTRUMENT) {
  console.error(
    "INSTRUMENT env var is required (e.g. GOLD/USD, or see constants.ts for options)",
  );
  process.exit(1);
}

const anchorPrice = Number(process.env.PRICE);
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

const anchorQ32 = Number(priceToQ32(anchorPrice, instrument));
console.log(`anchor price: $${anchorPrice}`);

const askPrices = Object.keys(book.asks)
  .map(Number)
  .filter((p) => BigInt(book.asks[p]!.remainingQuantity) > 0n)
  .sort((a, b) => a - b);
const bidPrices = Object.keys(book.bids)
  .map(Number)
  .filter((p) => BigInt(book.bids[p]!.remainingQuantity) > 0n)
  .sort((a, b) => b - a);

let buyLots = 0n;
let buyQuoteLots = 0n;
for (const p of askPrices) {
  if (p > anchorQ32) break;
  const available = BigInt(book.asks[p]!.remainingQuantity);
  buyLots += available;
  buyQuoteLots += (available * BigInt(p)) >> 32n;
  console.log(
    `  buy ${TokenAmount.fromRaw(fromLots(available, instrument.baseLotExp), instrument.base).human.toFixed(4)} @ $${q32ToPrice(BigInt(p), instrument).toFixed(4)}`,
  );
}

let sellLots = 0n;
let sellQuoteLots = 0n;
for (const p of bidPrices) {
  if (p < anchorQ32) break;
  const available = BigInt(book.bids[p]!.remainingQuantity);
  sellLots += available;
  sellQuoteLots += (available * BigInt(p)) >> 32n;
  console.log(
    `  sell ${TokenAmount.fromRaw(fromLots(available, instrument.baseLotExp), instrument.base).human.toFixed(4)} @ $${q32ToPrice(BigInt(p), instrument).toFixed(4)}`,
  );
}

if (buyLots === 0n && sellLots === 0n) {
  console.log("no arbitrage opportunity found");
  process.exit(0);
}

if (buyLots > 0n) {
  const quantity = TokenAmount.fromRaw(
    fromLots(buyLots, instrument.baseLotExp),
    instrument.base,
  );
  const depositAmount = TokenAmount.fromRaw(
    fromLots(buyQuoteLots, instrument.quoteLotExp),
    instrument.quote,
  );
  const minReceived = quantity;

  const avgPrice = depositAmount.human / quantity.human;
  console.log(
    `arb buy: ${quantity.human.toFixed(4)} base @ avg $${avgPrice.toFixed(4)}`,
  );
  await deposit(account, { quantity: depositAmount });
  await marketOrder(account, {
    instrument,
    quantity,
    minReceived,
    side: "buy",
  });
}

if (sellLots > 0n) {
  const quantity = TokenAmount.fromRaw(
    fromLots(sellLots, instrument.baseLotExp),
    instrument.base,
  );
  const minReceived = TokenAmount.fromRaw(
    fromLots(sellQuoteLots, instrument.quoteLotExp),
    instrument.quote,
  );

  const avgPrice = minReceived.human / quantity.human;
  console.log(
    `arb sell: ${quantity.human.toFixed(4)} base @ avg $${avgPrice.toFixed(4)}`,
  );
  await deposit(account, { quantity });
  await marketOrder(account, {
    instrument,
    quantity,
    minReceived,
    side: "sell",
  });
}
