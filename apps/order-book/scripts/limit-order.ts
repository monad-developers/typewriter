import { baseToQuote, priceToQ32, TokenAmount } from "order-book-sdk";
import { createAccount, deposit, limitOrder } from "./src/client";
import { instrumentEnv, requiredEnv, sideEnv } from "./src/env";

const price = Number(requiredEnv("PRICE", "2400 for $2400"));
const side = sideEnv();
const humanQuantity = Number(requiredEnv("QUANTITY", "1 for 1 unit"));
const { instrument } = instrumentEnv();

const account = await createAccount();
console.log(`account ${account.accountID}`);

const quantity = TokenAmount.from(humanQuantity, instrument.base);
console.log(
  `amount: ${quantity.human} (raw: ${quantity.raw}, asset: ${quantity.asset})`,
);
if (side === "buy") {
  // quote
  await deposit(account, {
    quantity: baseToQuote(quantity, priceToQ32(price, instrument), instrument),
  });
} else {
  // base
  await deposit(account, { quantity });
}

console.log(`placing ${side}: ${quantity.human} @ $${price}...`);
await limitOrder(account, { instrument, quantity, price, side });
