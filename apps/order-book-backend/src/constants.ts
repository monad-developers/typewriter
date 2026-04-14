import type { Address } from "viem";
import { extractChain } from "viem";
import { anvil, monadTestnet } from "viem/chains";

const chains = [anvil, monadTestnet] as const;

if (!process.env.BUN_PUBLIC_CHAIN_ID)
  throw new Error("BUN_PUBLIC_CHAIN_ID env var is required");
export const CHAIN_ID = Number(process.env.BUN_PUBLIC_CHAIN_ID);

export const CHAIN = extractChain({
  chains,
  id: CHAIN_ID as (typeof chains)[number]["id"],
}) as typeof anvil | typeof monadTestnet;

if (!process.env.BUN_PUBLIC_RPC_URL)
  throw new Error("BUN_PUBLIC_RPC_URL env var is required");
export const RPC_URL = process.env.BUN_PUBLIC_RPC_URL;

if (!process.env.BUN_PUBLIC_EXCHANGE_ADDRESS)
  throw new Error("BUN_PUBLIC_EXCHANGE_ADDRESS env var is required");
export const EXCHANGE_ADDRESS = process.env
  .BUN_PUBLIC_EXCHANGE_ADDRESS as Address;
