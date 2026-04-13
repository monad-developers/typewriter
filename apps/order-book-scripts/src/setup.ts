import type { Address } from "viem";
import {
  API_URL,
  GOLD,
  GOLD_Q32_PRICE,
  USD,
  WTIOIL,
  WTIOIL_Q32_PRICE,
} from "./constants";
import { q32ToPrice } from "./utils";

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
