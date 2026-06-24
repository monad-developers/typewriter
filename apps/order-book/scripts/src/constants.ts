import type { Address } from "ox/Address";

export { GOLD, INSTRUMENTS, USD, WTIOIL } from "order-book-sdk";

export function requiredEnv(name: string, value: string | undefined): string {
  if (value === undefined || value.trim() === "") {
    throw new Error(`${name} env var is required`);
  }

  return value;
}

export const API_URL = requiredEnv("API_URL", process.env.API_URL);
export const CHAIN_ID = Number(requiredEnv("CHAIN_ID", process.env.CHAIN_ID));
if (Number.isNaN(CHAIN_ID)) {
  throw new Error("CHAIN_ID must be a number");
}

export const ORDER_BOOK_ADDRESS = requiredEnv(
  "ORDER_BOOK_ADDRESS",
  process.env.ORDER_BOOK_ADDRESS,
) as Address;
