import type { Address } from "ox/Address";

export { GOLD, INSTRUMENTS, USD, WTIOIL } from "order-book-sdk";

function requiredEnv(name: string, value: string | undefined): string {
  if (value === undefined || value.trim() === "") {
    throw new Error(`${name} env var is required`);
  }

  return value;
}

export const API_URL = requiredEnv("API_URL", process.env.API_URL);
const chainId = Number(
  requiredEnv(
    "CHAIN_ID or BUN_PUBLIC_CHAIN_ID",
    process.env.CHAIN_ID ?? process.env.BUN_PUBLIC_CHAIN_ID,
  ),
);
if (Number.isNaN(chainId)) {
  throw new Error("CHAIN_ID or BUN_PUBLIC_CHAIN_ID must be a number");
}

export const CHAIN_ID = chainId;
export const EXCHANGE_ADDRESS = (process.env.EXCHANGE_ADDRESS ??
  requiredEnv(
    "EXCHANGE_ADDRESS or BUN_PUBLIC_EXCHANGE_ADDRESS",
    process.env.BUN_PUBLIC_EXCHANGE_ADDRESS,
  )) as Address;
export const RPC_URL = requiredEnv(
  "RPC_URL or BUN_PUBLIC_RPC_URL",
  process.env.RPC_URL ?? process.env.BUN_PUBLIC_RPC_URL,
);
export const SCHEDULER_ADDRESS = requiredEnv(
  "SCHEDULER_ADDRESS",
  process.env.SCHEDULER_ADDRESS,
) as Address;
