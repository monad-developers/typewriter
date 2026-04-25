import {
  fromLots,
  type InstrumentConfig,
  q32ToPrice,
  TokenAmount,
  toLots,
} from "order-book-sdk";
import { INSTRUMENTS } from "../src/constants";
import { createAccount, deposit, fetchState, marketOrder } from "../src/sdk";

const DEFAULT_INTERVAL = 10_000;
// 0 means skip the iteration, simulating a retail trader who is only
// sometimes active. Repeated weights bias toward common sizes.
const QUANTITIES = [0, 0, 0, 0, 0.1, 0.25, 0.5, 1, 2, 2, 5, 10];

const instruments = resolveInstruments();
const interval = Number(process.env.INTERVAL ?? DEFAULT_INTERVAL);

let account: Awaited<ReturnType<typeof createAccount>>;
while (true) {
  try {
    account = await createAccount();
    break;
  } catch (err) {
    console.error(
      "createAccount failed, retrying:",
      err instanceof Error ? err.message : err,
    );
    await Bun.sleep(interval);
  }
}
console.log(`account ${account.address}`);
console.log(
  `interval: ${interval}ms, instruments: ${instruments.map((i) => i.name).join(", ")}`,
);

while (true) {
  for (const inst of instruments) {
    try {
      await tick(inst.instrument, inst.name);
    } catch (err) {
      console.error(
        `[${inst.name}] iteration failed:`,
        err instanceof Error ? err.message : err,
      );
    }
  }
  await Bun.sleep(interval);
}

function resolveInstruments(): {
  name: keyof typeof INSTRUMENTS;
  instrument: InstrumentConfig;
}[] {
  if (!process.env.INSTRUMENT) {
    return Object.entries(INSTRUMENTS).map(([name, instrument]) => ({
      name: name as keyof typeof INSTRUMENTS,
      instrument,
    }));
  }
  const name = process.env.INSTRUMENT as keyof typeof INSTRUMENTS;
  const instrument = INSTRUMENTS[name];
  if (!instrument) {
    console.error(`unknown instrument: ${name}`);
    process.exit(1);
  }
  return [{ name, instrument }];
}

async function tick(instrument: InstrumentConfig, label: string) {
  const humanQuantity =
    QUANTITIES[Math.floor(Math.random() * QUANTITIES.length)]!;
  if (humanQuantity === 0) {
    console.log(`[${label}] skip`);
    return;
  }

  const side = Math.random() < 0.5 ? "buy" : ("sell" as "buy" | "sell");

  const state = await fetchState();
  const book = state.instruments[instrument.id];
  if (!book) {
    console.log(`[${label}] instrument not found on-chain, skipping`);
    return;
  }

  const quantity = TokenAmount.from(humanQuantity, instrument.base);
  const quantityLots = toLots(quantity.raw, instrument.baseLotExp);

  const ticks = side === "buy" ? book.asks : book.bids;
  const prices = Object.keys(ticks)
    .map(Number)
    .filter((p) => BigInt(ticks[p]!.remainingQuantity) > 0n)
    .sort((a, b) => (side === "buy" ? a - b : b - a));

  let remainingLots = quantityLots;
  let quoteLots = 0n;

  for (const price of prices) {
    if (remainingLots === 0n) break;
    const available = BigInt(ticks[price]!.remainingQuantity);
    const fillLots = remainingLots < available ? remainingLots : available;
    quoteLots += (fillLots * BigInt(price)) >> 32n;
    remainingLots -= fillLots;
  }

  if (remainingLots > 0n) {
    console.log(
      `[${label}] insufficient liquidity for ${side} ${humanQuantity}, skipping`,
    );
    return;
  }

  if (side === "buy") {
    await deposit(account, {
      quantity: TokenAmount.fromRaw(
        fromLots(quoteLots, instrument.quoteLotExp),
        instrument.quote,
      ),
    });
  } else {
    await deposit(account, { quantity });
  }

  const avgQ32 = (quoteLots << 32n) / quantityLots;
  const avgPrice = q32ToPrice(avgQ32, instrument);
  console.log(`[${label}] ${side} ${humanQuantity} @ ~$${avgPrice.toFixed(2)}`);

  await marketOrder(account, {
    instrument,
    quantity,
    side,
    minReceived: TokenAmount.from(
      0,
      side === "buy" ? instrument.base : instrument.quote,
    ),
  });
}
