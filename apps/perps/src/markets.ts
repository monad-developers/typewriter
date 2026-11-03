import { lotPrice, MARKETS } from "perps-sdk";
import { admin } from "./admin";
import { marketExists } from "./read";

/** Lists every market in the SDK that isn't listed yet. */
export async function listMarkets() {
  await Promise.all(
    Object.values(MARKETS)
      .filter((market) => !marketExists(BigInt(market.id)))
      .map((market) =>
        admin.execute("AddMarket", {
          marketId: BigInt(market.id),
          tickSize: market.tickSize,
          oraclePrice: lotPrice(market.initialPrice, market),
          initialMarginBps: market.initialMarginBps,
          maintenanceMarginBps: market.maintenanceMarginBps,
          takerFeeBps: market.takerFeeBps,
          liquidationFeeBps: market.liquidationFeeBps,
        }),
      ),
  );
}
