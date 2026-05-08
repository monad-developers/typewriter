import { fromLots, priceToQ32, q32ToPrice, TokenAmount } from "order-book-sdk";
import { INSTRUMENTS } from "./src/constants";
import {
  createAccount,
  deposit,
  estimateFillToPrice,
  marketOrder,
} from "./src/sdk";

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

const account = await createAccount();
console.log(`account ${account.address}`);

const anchorQ32 = priceToQ32(anchorPrice, instrument);
console.log(`anchor price: $${anchorPrice}`);

const [buyEstimate, sellEstimate] = await Promise.all([
  estimateFillToPrice({
    instrumentId: instrument.id,
    side: "buy",
    priceQ32: anchorQ32,
  }),
  estimateFillToPrice({
    instrumentId: instrument.id,
    side: "sell",
    priceQ32: anchorQ32,
  }),
]);

for (const fill of buyEstimate.fills) {
  console.log(
    `  buy ${TokenAmount.fromRaw(fromLots(fill.quantity, instrument.baseLotExp), instrument.base).human.toFixed(4)} @ $${q32ToPrice(BigInt(fill.price), instrument).toFixed(4)}`,
  );
}
for (const fill of sellEstimate.fills) {
  console.log(
    `  sell ${TokenAmount.fromRaw(fromLots(fill.quantity, instrument.baseLotExp), instrument.base).human.toFixed(4)} @ $${q32ToPrice(BigInt(fill.price), instrument).toFixed(4)}`,
  );
}

const buyLots = buyEstimate.totalQuantity;
const buyQuoteLots = buyEstimate.quoteQuantity;
const sellLots = sellEstimate.totalQuantity;
const sellQuoteLots = sellEstimate.quoteQuantity;

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
