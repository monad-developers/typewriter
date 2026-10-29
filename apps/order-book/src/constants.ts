import type { Address, Hex } from "viem";
import { extractChain } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { anvil, monadTestnet } from "viem/chains";

const chains = [anvil, monadTestnet] as const;

/**
 * Without RPC_URL, development runs on a local Anvil that typewriter starts
 * and deploys the order book to.
 */
export const DEV =
  process.env.NODE_ENV !== "production" && process.env.RPC_URL === undefined;

function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") {
    throw new Error(`${name} env var is required`);
  }
  return value;
}

/** The deployed order book's chain, read outside `DEV`. */
export function network() {
  const chain = extractChain({
    chains,
    id: Number(requireEnv("CHAIN_ID")) as (typeof chains)[number]["id"],
  }) as typeof anvil | typeof monadTestnet;

  const rpcUrls = requireEnv("RPC_URL")
    .split(",")
    .map((url) => url.trim())
    .filter((url) => url.length > 0);
  if (rpcUrls.length === 0)
    throw new Error("RPC_URL must contain at least one URL");

  return {
    address: requireEnv("ORDER_BOOK_ADDRESS") as Address,
    account: privateKeyToAccount(requireEnv("PRIVATE_KEY") as Hex),
    chainId: chain.id,
    rpcUrl: rpcUrls,
  };
}
