import type { Address } from "viem";
import { extractChain } from "viem";
import { anvil, monadTestnet } from "viem/chains";

const chains = [anvil, monadTestnet] as const;

if (!process.env.CHAIN_ID) throw new Error("CHAIN_ID env var is required");
export const CHAIN_ID = Number(process.env.CHAIN_ID);

export const CHAIN = extractChain({
  chains,
  id: CHAIN_ID as (typeof chains)[number]["id"],
}) as typeof anvil | typeof monadTestnet;

if (!process.env.RPC_URL) throw new Error("RPC_URL env var is required");
export const RPC_URLS = process.env.RPC_URL.split(",")
  .map((url) => url.trim())
  .filter((url) => url.length > 0);
if (RPC_URLS.length === 0)
  throw new Error("RPC_URL must contain at least one URL");
export const RPC_URL = RPC_URLS[0]!;

if (!process.env.ORDER_BOOK_ADDRESS)
  throw new Error("ORDER_BOOK_ADDRESS env var is required");
export const ORDER_BOOK_ADDRESS = process.env.ORDER_BOOK_ADDRESS as Address;
