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

function optionalEnv(name: string): string | undefined {
  const value = process.env[name];
  return value === undefined || value === "" ? undefined : value;
}

export const dev = process.env.NODE_ENV !== "production";

export const databaseUrl = requireEnv("DATABASE_URL");

const relayerPrivateKey = optionalEnv("RELAYER_PRIVATE_KEY");

export const app = await createTypewriter(OrderBook, {
  dev,
  ...(dev
    ? {}
    : {
        deployment: requireEnv("DEPLOYMENT"),
        root: requireEnv("ROOT_ADDRESS") as Address,
        scheduler: privateKeyToAccount(
          requireEnv("SCHEDULER_PRIVATE_KEY") as Hex,
        ),
        relayer:
          relayerPrivateKey === undefined
            ? undefined
            : privateKeyToAccount(relayerPrivateKey as Hex),
        chainId: Number(requireEnv("CHAIN_ID")),
        rpcUrl: requireEnv("RPC_URL")
          .split(",")
          .map((url) => url.trim()),
      }),
  database: {
    url: databaseUrl,
    maxConnections: 25,
  },
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

console.log(
  `${app.migration === "created" ? "Deployed" : "Resumed"} the order book at ${app.address} on chain ${app.manifest.chainId}`,
);

// A new deployment starts empty: list the instruments and fund the makers.
if (app.migration === "created") await seed(app.manifest, app.execute);
