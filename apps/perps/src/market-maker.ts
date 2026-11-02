import { Secp256k1 } from "ox";
import { dollars, Side, secp256k1Signer } from "perps-sdk";
import { admin } from "./admin";
import { app } from "./app";
import { accountOrders, marketIds, marketSummary } from "./read";

const LADDER_BPS = [5n, 10n, 25n, 50n];
const LEVEL_NOTIONAL = dollars(5_000);
const DEPOSIT = dollars(10_000_000);

/**
 * A dev-only maker that quotes a ladder around each oracle price, cancelling
 * and replacing it every `intervalMs`, so takers and liquidations always find
 * liquidity near the mark.
 */
export async function startMarketMaker(intervalMs: number) {
  const maker = secp256k1Signer(app.manifest, Secp256k1.randomPrivateKey());
  await app.execute(maker.createAccount);
  await admin.execute("Deposit", { account: maker.accountID, amount: DEPOSIT });

  let quoting = false;
  const requote = async () => {
    if (quoting) return;
    quoting = true;
    const cancels = accountOrders(maker.accountID).map(({ orderId }) =>
      app.execute(maker.sign("CancelOrder", { orderId })),
    );
    const quotes = marketIds().flatMap((marketId) => {
      const { oraclePrice, tickSize } = marketSummary(marketId);
      const quantity = LEVEL_NOTIONAL / oraclePrice;
      return LADDER_BPS.flatMap((bps) => [
        {
          side: Side.Buy,
          price:
            ((oraclePrice * (10_000n - bps)) / 10_000n / tickSize) * tickSize,
        },
        {
          side: Side.Sell,
          price:
            ((oraclePrice * (10_000n + bps)) / 10_000n / tickSize + 1n) *
            tickSize,
        },
      ]).map(({ side, price }) =>
        app.execute(
          maker.sign("LimitOrder", { marketId, side, price, quantity }),
        ),
      );
    });
    // Fills and crossing quotes reject some of these; the next requote fixes
    // the book.
    await Promise.allSettled([...cancels, ...quotes]);
    quoting = false;
  };

  await requote();
  return setInterval(requote, intervalMs);
}
