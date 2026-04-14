import type { Instrument } from "order-book-backend/src/exchange";
import { INSTRUMENTS } from "./constants";
import { priceToQ32, q32ToPrice, TokenAmount } from "order-book-sdk";
import { createAccount, deposit, fetchState, marketOrder } from "./sdk";

if (!process.env.PRICE) {
  console.error("PRICE env var is required (e.g. 2400 for $2400)");
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

function findArbOpportunity(
  instrument: Instrument,
  realQ32: bigint,
): { side: 0 | 1; lots: bigint; minReceivedLots: bigint } | null {
  const toPrice = (q32: number) => q32ToPrice(BigInt(q32), inst);

  const askPrices = Object.keys(instrument.asks)
    .map(Number)
    .sort((a, b) => a - b);
  const bidPrices = Object.keys(instrument.bids)
    .map(Number)
    .sort((a, b) => b - a);

  for (const p of askPrices) {
    if (BigInt(p) >= realQ32) break;
    const tick = instrument.asks[p]!;
    const remaining = BigInt(tick.remainingQuantity);
    if (remaining <= 0n) continue;
    console.log(
      `arb: buy ${remaining} lots @ $${toPrice(p).toFixed(4)} (below real $${inputPrice})`,
    );
    return { side: 0, lots: remaining, minReceivedLots: remaining };
  }

  for (const p of bidPrices) {
    if (BigInt(p) <= realQ32) break;
    const tick = instrument.bids[p]!;
    const remaining = BigInt(tick.remainingQuantity);
    if (remaining <= 0n) continue;
    const minReceivedLots = (remaining * BigInt(p)) >> 32n;
    console.log(
      `arb: sell ${remaining} lots @ $${toPrice(p).toFixed(4)} (above real $${inputPrice})`,
    );
    return { side: 1, lots: remaining, minReceivedLots };
  }

  return null;
}

const state = await fetchState();
console.log(state.instruments[0]!.bids);
const instrument = state.instruments[inst.id];
if (!instrument) {
  console.error(`instrument ${inst.id} not found, run setup first`);
  process.exit(1);
}

const realQ32 = priceToQ32(inputPrice, inst);
console.log(`real price: $${inputPrice} (Q32: ${realQ32})`);

const arb = findArbOpportunity(instrument, realQ32);
if (!arb) {
  console.log("no arbitrage opportunity found");
  process.exit(0);
}

const account = await createAccount();
console.log(`account ${account.address}`);

const baseRaw = arb.lots << BigInt(inst.baseLotExp);
const quantity = TokenAmount.fromRaw(baseRaw, inst.base);

const side = arb.side === 0 ? "buy" : ("sell" as "buy" | "sell");

if (side === "buy") {
  const quoteLots = (arb.lots * realQ32) >> 32n;
  const rawQuote = (quoteLots + 1n) << BigInt(inst.quoteLotExp);
  const maxCost = TokenAmount.fromRaw(rawQuote, inst.quote);
  console.log(`minting ${maxCost.human} quote to cover buy...`);
  await deposit(account, { quantity: maxCost });
} else {
  console.log(`minting ${quantity.human} base to cover sell...`);
  await deposit(account, { quantity });
}

const minReceivedRaw =
  arb.minReceivedLots <<
  BigInt(side === "buy" ? inst.baseLotExp : inst.quoteLotExp);
const minReceived = TokenAmount.fromRaw(
  minReceivedRaw,
  side === "buy" ? inst.base : inst.quote,
);

const result = await marketOrder(account, {
  instrument: inst,
  quantity,
  minReceived,
  side,
});
console.log("market order filled:", result);
console.log("done");
