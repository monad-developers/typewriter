import {
  fromLots,
  type InstrumentConfig,
  q32ToPrice,
  TokenAmount,
  toLots,
} from "order-book-sdk";
import {
  createAccountRetrying,
  deposit,
  estimateMarketOrder,
  marketOrder,
} from "./src/client";
import { instrumentsEnv, intervalEnv } from "./src/env";

// 0 means skip the iteration, simulating a retail trader who is only
// sometimes active. Repeated weights bias toward common sizes.
const QUANTITIES = [0, 0, 0, 0, 0.1, 0.25, 0.5, 1, 2, 2, 5, 10];

const instruments = instrumentsEnv();
const interval = intervalEnv();

const account = await createAccountRetrying(interval);
console.log(`account ${account.accountID}`);
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

async function tick(instrument: InstrumentConfig, label: string) {
  const humanQuantity =
    QUANTITIES[Math.floor(Math.random() * QUANTITIES.length)]!;
  if (humanQuantity === 0) {
    console.log(`[${label}] skip`);
    return;
  }

  const side = Math.random() < 0.5 ? "buy" : ("sell" as "buy" | "sell");

  const quantity = TokenAmount.from(humanQuantity, instrument.base);
  const quantityLots = toLots(quantity.raw, instrument.baseLotExp);

  let quoteLots: bigint;
  try {
    const estimate = await estimateMarketOrder({
      instrumentId: instrument.id,
      side,
      quantityLots,
    });
    quoteLots = estimate.quoteQuantity;
  } catch (err) {
    console.log(
      `[${label}] insufficient liquidity for ${side} ${humanQuantity}, skipping (${err instanceof Error ? err.message : err})`,
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
