/**
 * Opens a leveraged BTC long, drops the oracle through the dev endpoint, and
 * waits for the server's liquidator to close it. Needs a dev server.
 */
import { Secp256k1 } from "ox";
import {
  dollars,
  MARKETS,
  type PerpsManifest,
  type PerpsMutation,
  Side,
  secp256k1Signer,
  toDollars,
} from "perps-sdk";
import superjson from "superjson";

const API_URL = process.env.API_URL ?? "http://localhost:3000";
const MARKET = MARKETS["BTC-PERP"];
const marketId = BigInt(MARKET.id);

async function api<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${API_URL}${path}`, {
    method: body === undefined ? "GET" : "POST",
    body: body === undefined ? undefined : superjson.stringify(body),
  });
  const result = superjson.parse<T & { error?: string }>(await response.text());
  if (!response.ok) throw new Error(`${path}: ${result.error}`);
  return result;
}

const submit = (mutation: PerpsMutation) => api("/api", mutation);

type Market = { oraclePrice: bigint; bestAsk: bigint | null };
type Account = {
  collateral: bigint;
  equity: bigint;
  maintenanceMargin: bigint;
  positions: { marketId: bigint; size: bigint }[];
};

const manifest = await api<PerpsManifest>("/api/manifest");
const trader = secp256k1Signer(manifest, Secp256k1.randomPrivateKey());
await submit(trader.createAccount);
await api("/api/dev/faucet", {
  account: trader.accountID,
  amount: dollars(1_000),
});

const market = await api<Market>(`/api/markets/${marketId}`);
// About 9.3x: the most 10% initial margin allows after the fee.
const quantity = dollars(9_300) / market.oraclePrice;
await submit(
  trader.sign("MarketOrder", {
    marketId,
    side: Side.Buy,
    quantity,
    limitPrice: ((market.bestAsk ?? market.oraclePrice) * 101n) / 100n,
  }),
);
const opened = await api<Account>(`/api/accounts/${trader.accountID}`);
console.log("opened", {
  size: opened.positions[0]?.size,
  equity: toDollars(opened.equity),
  maintenanceMargin: toDollars(opened.maintenanceMargin),
});

const crashed = (market.oraclePrice * 92n) / 100n;
await api("/api/dev/oracle", { marketId, price: crashed });
console.log("oracle", toDollars(market.oraclePrice), "->", toDollars(crashed));

for (let attempt = 0; attempt < 50; attempt++) {
  const account = await api<Account>(`/api/accounts/${trader.accountID}`);
  const size =
    account.positions.find((p) => p.marketId === marketId)?.size ?? 0n;
  if (size === 0n) {
    console.log("liquidated", {
      collateral: toDollars(account.collateral),
      equity: toDollars(account.equity),
    });
    const liquidations = await api<unknown[]>("/api/liquidations");
    console.log(liquidations[0]);
    process.exit(0);
  }
  await Bun.sleep(100);
}
console.error("not liquidated after 5s");
process.exit(1);
