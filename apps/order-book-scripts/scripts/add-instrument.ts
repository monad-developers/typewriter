import { baseToQuote, priceToQ32, q32ToPrice, TokenAmount } from "order-book-sdk";
import { INSTRUMENTS } from "../src/constants";
import {
  addInstrument,
  createAccount,
  deposit,
  limitOrder,
} from "../src/sdk";

const GOLD_PRICE = 2400;
const WTIOIL_PRICE = 80;
const EUR_PRICE = 1.1;
const SPX_PRICE = 5200;
const BTC_PRICE = 95000;

const GOLD_Q32_PRICE = priceToQ32(GOLD_PRICE, INSTRUMENTS["GOLD/USD"]);
const WTIOIL_Q32_PRICE = priceToQ32(WTIOIL_PRICE, INSTRUMENTS["WTIOIL/USD"]);
const EUR_Q32_PRICE = priceToQ32(EUR_PRICE, INSTRUMENTS["EUR/USD"]);
const SPX_Q32_PRICE = priceToQ32(SPX_PRICE, INSTRUMENTS["SPX/USD"]);
const BTC_Q32_PRICE = priceToQ32(BTC_PRICE, INSTRUMENTS["BTC/USD"]);

const TARGET_LOT = 0.0001;

console.log(
  `GOLD/USD price: $${q32ToPrice(GOLD_Q32_PRICE, INSTRUMENTS["GOLD/USD"])}`,
);
console.log(
  `WTIOIL/USD price: $${q32ToPrice(WTIOIL_Q32_PRICE, INSTRUMENTS["WTIOIL/USD"])}`,
);
console.log(
  `EUR/USD price: $${q32ToPrice(EUR_Q32_PRICE, INSTRUMENTS["EUR/USD"])}`,
);
console.log(
  `SPX/USD price: $${q32ToPrice(SPX_Q32_PRICE, INSTRUMENTS["SPX/USD"])}`,
);
console.log(
  `BTC/USD price: $${q32ToPrice(BTC_Q32_PRICE, INSTRUMENTS["BTC/USD"])}`,
);

const USD_LOT_EXP = Math.floor(Math.log2(TARGET_LOT * 10 ** 18));
const GOLD_LOT_EXP = Math.floor(
  Math.log2(TARGET_LOT * 10 ** 18) - Math.log2(GOLD_PRICE),
);
const WTIOIL_LOT_EXP = Math.floor(
  Math.log2(TARGET_LOT * 10 ** 18) - Math.log2(WTIOIL_PRICE),
);
const EUR_LOT_EXP = Math.floor(
  Math.log2(TARGET_LOT * 10 ** 18) - Math.log2(EUR_PRICE),
);
const SPX_LOT_EXP = Math.floor(
  Math.log2(TARGET_LOT * 10 ** 18) - Math.log2(SPX_PRICE),
);
const BTC_LOT_EXP = Math.floor(
  Math.log2(TARGET_LOT * 10 ** 18) - Math.log2(BTC_PRICE),
);
console.log(`USD lot exp: ${USD_LOT_EXP}`);
console.log(`GOLD lot exp: ${GOLD_LOT_EXP}`);
console.log(`WTIOIL lot exp: ${WTIOIL_LOT_EXP}`);
console.log(`EUR lot exp: ${EUR_LOT_EXP}`);
console.log(`SPX lot exp: ${SPX_LOT_EXP}`);
console.log(`BTC lot exp: ${BTC_LOT_EXP}`);

console.log(`USD lot value: ${2 ** USD_LOT_EXP / 10 ** 18}`);
console.log(`GOLD lot value: ${(GOLD_PRICE * 2 ** GOLD_LOT_EXP) / 10 ** 18}`);
console.log(
  `WTIOIL lot value: ${(WTIOIL_PRICE * 2 ** WTIOIL_LOT_EXP) / 10 ** 18}`,
);
console.log(`EUR lot value: ${(EUR_PRICE * 2 ** EUR_LOT_EXP) / 10 ** 18}`);
console.log(`SPX lot value: ${(SPX_PRICE * 2 ** SPX_LOT_EXP) / 10 ** 18}`);
console.log(`BTC lot value: ${(BTC_PRICE * 2 ** BTC_LOT_EXP) / 10 ** 18}`);

const SEED_QUANTITY = 1;

const PRICES: Record<keyof typeof INSTRUMENTS, number> = {
  "GOLD/USD": GOLD_PRICE,
  "WTIOIL/USD": WTIOIL_PRICE,
  "EUR/USD": EUR_PRICE,
  "SPX/USD": SPX_PRICE,
  "BTC/USD": BTC_PRICE,
};

const admin = await createAccount();

for (const name of [
  "GOLD/USD",
  "WTIOIL/USD",
  "EUR/USD",
  "SPX/USD",
  "BTC/USD",
] as const) {
  const inst = INSTRUMENTS[name];
  await addInstrument(admin, {
    instrumentId: inst.id,
    base: inst.base,
    quote: inst.quote,
    baseLotExp: inst.baseLotExp,
    quoteLotExp: inst.quoteLotExp,
  });
  console.log(`added ${name}`);

  const price = PRICES[name];
  const quantity = TokenAmount.from(SEED_QUANTITY, inst.base);
  const quoteDeposit = baseToQuote(
    quantity,
    priceToQ32(price, inst),
    inst,
  );
  await deposit(admin, { quantity });
  await deposit(admin, { quantity: quoteDeposit });
  await limitOrder(admin, { instrument: inst, quantity, price, side: "buy" });
  await limitOrder(admin, { instrument: inst, quantity, price, side: "sell" });
  console.log(`seeded ${name}: 1 buy + 1 sell @ $${price}`);
}
