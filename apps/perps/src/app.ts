import { createTypewriter } from "typewriter";
import type { Address, Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import Perps from "../contracts/src/Perps.sol";

export function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") {
    throw new Error(`${name} env var is required`);
  }
  return value;
}

export const dev = process.env.NODE_ENV !== "production";

export const app = await createTypewriter(Perps, {
  dev,
  ...(dev
    ? {}
    : {
        address: requireEnv("PERPS_ADDRESS") as Address,
        account: privateKeyToAccount(requireEnv("PRIVATE_KEY") as Hex),
        chainId: Number(requireEnv("CHAIN_ID")),
        rpcUrl: requireEnv("RPC_URL")
          .split(",")
          .map((url) => url.trim()),
      }),
  database: { url: requireEnv("DATABASE_URL"), maxConnections: 25 },
  sequencing: {
    order: "batch",
    // Config and collateral land before prices, so a batch trades at its own
    // oracle price; cancels and new quotes land before liquidations, so
    // liquidations hit fresh liquidity before takers do.
    batchOrder: [
      "SetAdmin",
      "AddMarket",
      "UpdateMarket",
      "Deposit",
      "SetOraclePrices",
      "AccrueFunding",
      "CancelOrder",
      "LimitOrder",
      "Liquidate",
      "MarketOrder",
      "Withdrawal",
    ],
  },
});
