import { INSTRUMENTS } from "./constants";
import { addInstrument, q32ToPrice } from "./sdk";

const GOLD_Q32_PRICE = 21_110_623_253_299_200n;
const WTIOIL_Q32_PRICE = 16_492_674_416_640n;

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

console.log("setup complete");
console.log(`GOLD/USD price: $${q32ToPrice(GOLD_Q32_PRICE, gold)}`);
console.log(`WTIOIL/USD price: $${q32ToPrice(WTIOIL_Q32_PRICE, oil)}`);
