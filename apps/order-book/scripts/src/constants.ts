import type { Address } from "ox/Address";

export { GOLD, INSTRUMENTS, USD, WTIOIL } from "order-book-sdk";

export function requiredEnv(name: string, value: string | undefined): string {
  if (value === undefined || value.trim() === "") {
    throw new Error(`${name} env var is required`);
  }

  return value;
}

export const API_URL = requiredEnv("API_URL", process.env.API_URL);
export const CHAIN_ID = Number(
  requiredEnv(
    "CHAIN_ID or BUN_PUBLIC_CHAIN_ID",
    process.env.CHAIN_ID ?? process.env.BUN_PUBLIC_CHAIN_ID,
  ),
);
if (Number.isNaN(CHAIN_ID)) {
  throw new Error("CHAIN_ID or BUN_PUBLIC_CHAIN_ID must be a number");
}

export const EXCHANGE_ADDRESS = requiredEnv(
  "EXCHANGE_ADDRESS or BUN_PUBLIC_EXCHANGE_ADDRESS",
  process.env.EXCHANGE_ADDRESS ?? process.env.BUN_PUBLIC_EXCHANGE_ADDRESS,
) as Address;
