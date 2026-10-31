import { createTypewriter } from "typewriter";
import type { Address, Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import OrderBook from "../contracts/src/OrderBook.sol";
import { seed } from "./seed";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") {
    throw new Error(`${name} env var is required`);
  }
  return value;
}

export const dev = process.env.NODE_ENV !== "production";

export const databaseUrl = requireEnv("DATABASE_URL");

export const app = await createTypewriter(OrderBook, {
  dev,
  ...(dev
    ? {}
    : {
        address: requireEnv("ORDER_BOOK_ADDRESS") as Address,
        account: privateKeyToAccount(requireEnv("PRIVATE_KEY") as Hex),
        chainId: Number(requireEnv("CHAIN_ID")),
        rpcUrl: requireEnv("RPC_URL")
          .split(",")
          .map((url) => url.trim()),
      }),
  database: { url: databaseUrl, maxConnections: 25 },
  sequencing: {
    order: "batch",
    batchOrder: [
      "CloseOrder",
      "ChangeOrder",
      "LimitOrder",
      "MarketOrder",
      "AddInstrument",
      "Deposit",
      "Withdrawal",
    ],
  },
});

if (dev) await seed(app.manifest, app.execute);
