import {
  authorizeWithSecp256k1,
  baseToQuote,
  createSecp256k1Account,
  INSTRUMENTS,
  limitOrderParams,
  type OrderBookManifest,
  type OrderBookMutation,
  type OrderBookMutationName,
  priceToQ32,
  randomNonce,
  TokenAmount,
} from "order-book-sdk";
import { Secp256k1 } from "ox";
import type { Address } from "ox/Address";
import type { TypedMutation } from "typewriter/client";

const PRICES: Record<keyof typeof INSTRUMENTS, number> = {
  "GOLD/USD": 4740,
  "WTIOIL/USD": 94,
  "EUR/USD": 1.17,
  "SPX/USD": 7165,
  "BTC/USD": 77300,
};
const LADDER_BPS = [1, 5, 10, 25];
const QUANTITY = 1;

/**
 * Adds every instrument and, from a new account, places limit orders on both
 * sides of its price.
 */
export async function seed(
  manifest: OrderBookManifest,
  execute: (mutation: OrderBookMutation) => Promise<unknown>,
) {
  const privateKey = Secp256k1.randomPrivateKey();
  const account = createSecp256k1Account(manifest, privateKey);
  const sign = <const name extends OrderBookMutationName>(
    name: name,
    params: TypedMutation<OrderBookManifest, name>["params"],
  ) =>
    authorizeWithSecp256k1(manifest, privateKey, {
      name,
      params,
      accountID: account.accountID,
      credentialID: 0n,
      nonce: randomNonce(),
      expiration: 0n,
    });

  const names = Object.keys(INSTRUMENTS) as (keyof typeof INSTRUMENTS)[];
  const orders = names.flatMap((name) =>
    LADDER_BPS.flatMap((bps) =>
      (["buy", "sell"] as const).map((side) => ({
        instrument: INSTRUMENTS[name],
        side,
        price: PRICES[name] * (1 + (side === "buy" ? -bps : bps) / 10_000),
        quantity: TokenAmount.from(QUANTITY, INSTRUMENTS[name].base),
      })),
    ),
  );
  const deposits = new Map<Address, bigint>();
  for (const { instrument, side, price, quantity } of orders) {
    const amount =
      side === "buy"
        ? baseToQuote(quantity, priceToQ32(price, instrument), instrument)
        : quantity;
    deposits.set(amount.asset, (deposits.get(amount.asset) ?? 0n) + amount.raw);
  }

  await execute(account.mutation);
  // A batch runs limit orders before instruments and deposits.
  await Promise.all([
    ...Object.values(INSTRUMENTS).map((instrument) =>
      execute(
        sign("AddInstrument", {
          instrumentId: BigInt(instrument.id),
          base: instrument.base,
          quote: instrument.quote,
          baseLotExp: instrument.baseLotExp,
          quoteLotExp: instrument.quoteLotExp,
        }),
      ),
    ),
    ...[...deposits].map(([asset, amount]) =>
      execute(sign("Deposit", { asset, amount })),
    ),
  ]);
  await Promise.all(
    orders.map((order) =>
      execute(sign("LimitOrder", limitOrderParams(order.instrument, order))),
    ),
  );
}
