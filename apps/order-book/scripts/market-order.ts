import { fromLots, q32ToPrice, TokenAmount, toLots } from "order-book-sdk";
import {
  createAccount,
  deposit,
  estimateMarketOrder,
  marketOrder,
} from "./src/client";
import { instrumentEnv, requiredEnv, sideEnv } from "./src/env";

const side = sideEnv();
const humanQuantity = Number(requiredEnv("QUANTITY", "1 for 1 unit of base"));
const { instrument } = instrumentEnv();

const account = await createAccount();
console.log(`account ${account.accountID}`);

const quantity = TokenAmount.from(humanQuantity, instrument.base);
console.log(
  `amount: ${quantity.human.toFixed(4)} (raw: ${quantity.raw}, asset: ${quantity.asset})`,
);

const quantityLots = toLots(quantity.raw, instrument.baseLotExp);

let quoteLots: bigint;
try {
  const estimate = await estimateMarketOrder({
    instrumentId: instrument.id,
    side,
    quantityLots,
  });
  quoteLots = estimate.quoteQuantity;
  for (const fill of estimate.fills) {
    console.log(
      `price: $${q32ToPrice(fill.price, instrument).toFixed(4)}, fill quantity: ${TokenAmount.fromRaw(fromLots(fill.quantity, instrument.baseLotExp), instrument.base).human.toFixed(4)}`,
    );
  }
} catch (err) {
  console.error(
    `insufficient liquidity (${err instanceof Error ? err.message : err})`,
  );
  process.exit(1);
}

const q32 = (quoteLots << 32n) / quantityLots;
console.log(
  `placing market ${side}: ${quantity.human.toFixed(4)} @~$${q32ToPrice(q32, instrument).toFixed(4)}...`,
);

if (side === "buy") {
  // quote
  await deposit(account, {
    quantity: TokenAmount.fromRaw(
      fromLots(quoteLots, instrument.quoteLotExp),
      instrument.quote,
    ),
  });
} else {
  // base
  await deposit(account, { quantity });
}

await marketOrder(account, {
  instrument,
  quantity,
  side,
  minReceived: TokenAmount.fromRaw(
    side === "buy" ? quantity.raw : fromLots(quoteLots, instrument.quoteLotExp),
    side === "buy" ? instrument.base : instrument.quote,
  ),
});
