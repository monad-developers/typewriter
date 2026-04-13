import type { Address } from "viem";

const API_URL = process.env.API_URL ?? "http://localhost:3000";

const CNY: Address = "0x1111111111111111111111111111111111111111";
const USD: Address = "0x2222222222222222222222222222222222222222";
const INR: Address = "0x3333333333333333333333333333333333333333";

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

async function main() {
  console.log(`using API at ${API_URL}`);

  await addInstrument({
    instrumentId: 0,
    base: CNY,
    quote: USD,
    baseLotExp: 0,
    quoteLotExp: 0,
  });

  await addInstrument({
    instrumentId: 1,
    base: INR,
    quote: USD,
    baseLotExp: 0,
    quoteLotExp: 0,
  });

  console.log("setup complete");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
