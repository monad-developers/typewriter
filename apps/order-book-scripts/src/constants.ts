import type { Address } from "ox/Address";

export { INSTRUMENTS, USD, GOLD, WTIOIL } from "order-book-sdk";

export const API_URL = process.env.API_URL ?? "http://localhost:3000";
export const CHAIN_ID = Number(process.env.CHAIN_ID ?? "31337");
export const EXCHANGE_ADDRESS = (process.env.EXCHANGE_ADDRESS ??
  "0x5fbdb2315678afecb367f032d93f642f64180aa3") as Address;
