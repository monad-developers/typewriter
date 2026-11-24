import {
  baseToQuote,
  INSTRUMENTS,
  limitOrderParams,
  type OrderBookManifest,
  type OrderBookMutation,
  type OrderBookMutationName,
  priceToQ32,
  randomNonce,
  secp256k1Signer,
  TokenAmount,
} from "order-book-sdk";
import { Secp256k1 } from "ox";
import type { Address } from "ox/Address";
import { createAccountMutation, type TypedMutation } from "typewriter/client";

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
  const signer = secp256k1Signer(manifest, Secp256k1.randomPrivateKey());
  const create = createAccountMutation(signer);
  const sign = <const name extends OrderBookMutationName>(
    name: name,
    params: TypedMutation<OrderBookManifest, name>["params"],
  ) =>
    signer.signMutation({
      name,
      params,
      accountID: create.accountID,
      credentialID: 0n,
      nonce: randomNonce(),
      expiration: 0,
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

  await execute(await signer.signMutation(create));
  // A batch runs limit orders before instruments and deposits.
  await Promise.all([
    ...Object.values(INSTRUMENTS).map((instrument) =>
      sign("AddInstrument", {
        instrumentId: BigInt(instrument.id),
        base: instrument.base,
        quote: instrument.quote,
        baseLotExp: instrument.baseLotExp,
        quoteLotExp: instrument.quoteLotExp,
      }).then(execute),
    ),
    ...[...deposits].map(([asset, amount]) =>
      sign("Deposit", { asset, amount }).then(execute),
    ),
  ]);
  await Promise.all(
    orders.map((order) =>
      sign("LimitOrder", limitOrderParams(order.instrument, order)).then(
        execute,
      ),
    ),
  );
}
