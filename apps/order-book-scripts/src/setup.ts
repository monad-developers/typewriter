import type { Address } from "viem";
import { q32ToPrice } from "./utils";

const API_URL = process.env.API_URL ?? "http://localhost:3000";

const USD: Address = "0x1111111111111111111111111111111111111111";
const GOLD: Address = "0x2222222222222222222222222222222222222222";
const WTIOIL: Address = "0x3333333333333333333333333333333333333333";

const GOLD_Q32_PRICE = 21_110_623_253_299_200n;
const WTIOIL_Q32_PRICE = 16_492_674_416_640n;

async function addInstrument(instrument: {
  instrumentId: number;
  base: Address;
  quote: Address;
  baseLotExp: number;
  quoteLotExp: number;
}) {
  const res = await fetch(`${API_URL}/api/add-instrument`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(instrument),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`add-instrument failed: ${data.error}`);
  console.log(
    `instrument ${instrument.instrumentId}: ${instrument.base} / ${instrument.quote} (id: ${data.id})`,
  );
  return data;
}

console.log(`using API at ${API_URL}`);

await addInstrument({
  instrumentId: 0,
  base: GOLD,
  quote: USD,
  baseLotExp: 35,
  quoteLotExp: 46,
});

await addInstrument({
  instrumentId: 1,
  base: WTIOIL,
  quote: USD,
  baseLotExp: 40,
  quoteLotExp: 46,
});

console.log("setup complete");
console.log(
  `GOLD/USD Q32 price: ${q32ToPrice(GOLD_Q32_PRICE, 35, 46, 18, 18)}`,
);
console.log(
  `WTIOIL/USD Q32 price: ${q32ToPrice(WTIOIL_Q32_PRICE, 40, 46, 18, 18)}`,
);
