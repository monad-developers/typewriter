import { INSTRUMENTS } from "./constants";
import { addInstrument, priceToQ32, q32ToPrice } from "./sdk";

// 5_033_164_800n;
const GOLD_Q32_PRICE = priceToQ32(2400, INSTRUMENTS["GOLD/USD"]);
// 5_368_709_120n;
const WTIOIL_Q32_PRICE = priceToQ32(80, INSTRUMENTS["WTIOIL/USD"]);

console.log(
  `GOLD/USD price: $${q32ToPrice(GOLD_Q32_PRICE, INSTRUMENTS["GOLD/USD"])}`,
);
console.log(
  `WTIOIL/USD price: $${q32ToPrice(WTIOIL_Q32_PRICE, INSTRUMENTS["WTIOIL/USD"])}`,
);

const gold = INSTRUMENTS["GOLD/USD"];
await addInstrument({
  instrumentId: gold.id,
  base: gold.base,
  quote: gold.quote,
  baseLotExp: gold.baseLotExp,
  quoteLotExp: gold.quoteLotExp,
});
console.log("added GOLD/USD");

const oil = INSTRUMENTS["WTIOIL/USD"];
await addInstrument({
  instrumentId: oil.id,
  base: oil.base,
  quote: oil.quote,
  baseLotExp: oil.baseLotExp,
  quoteLotExp: oil.quoteLotExp,
});
console.log("added WTIOIL/USD");

console.log("done");
