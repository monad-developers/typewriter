import { fromLots, q32ToPrice, TokenAmount, toLots } from "order-book-sdk";
import { INSTRUMENTS } from "./src/constants";
import {
  createAccount,
  deposit,
  estimateMarketOrder,
  marketOrder,
} from "./src/sdk";

if (!process.env.INSTRUMENT) {
  console.error(
    "INSTRUMENT env var is required (e.g. GOLD/USD, or see constants.ts for options)",
  );
  process.exit(1);
}

const instrumentName = process.env.INSTRUMENT as keyof typeof INSTRUMENTS;
const instrument = INSTRUMENTS[instrumentName];
if (!instrument) {
  console.error(`unknown instrument: ${instrumentName}`);
  process.exit(1);
}

const QUANTITIES = [0.1, 0.25, 0.5, 1, 2, 2, 5, 10];

const side = Math.random() < 0.5 ? "buy" : ("sell" as "buy" | "sell");
const humanQuantity =
  QUANTITIES[Math.floor(Math.random() * QUANTITIES.length)]!;

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
    `insufficient liquidity for ${side} ${humanQuantity}, skipping (${err instanceof Error ? err.message : err})`,
  );
  process.exit(0);
}

const account = await createAccount();
console.log(`account ${account.address}`);

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
console.log(`${side} ${humanQuantity} @ ~$${avgPrice.toFixed(2)}`);

await marketOrder(account, {
  instrument,
  quantity,
  side,
  minReceived: TokenAmount.from(
    0,
    side === "buy" ? instrument.base : instrument.quote,
  ),
});
