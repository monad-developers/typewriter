import type { Address } from "ox/Address";

export const API_URL = process.env.API_URL ?? "http://localhost:3000";
export const CHAIN_ID = Number(process.env.CHAIN_ID ?? "31337");
export const EXCHANGE_ADDRESS = (process.env.EXCHANGE_ADDRESS ??
  "0x5fbdb2315678afecb367f032d93f642f64180aa3") as Address;

export const USD: Address = "0x1111111111111111111111111111111111111111";
export const GOLD: Address = "0x2222222222222222222222222222222222222222";
export const WTIOIL: Address = "0x3333333333333333333333333333333333333333";

export const INSTRUMENTS = {
  "GOLD/USD": {
    id: 0,
    base: GOLD,
    quote: USD,
    baseLotExp: 35,
    quoteLotExp: 46,
    baseDecimals: 18,
    quoteDecimals: 18,
  },
  "WTIOIL/USD": {
    id: 1,
    base: WTIOIL,
    quote: USD,
    baseLotExp: 40,
    quoteLotExp: 46,
    baseDecimals: 18,
    quoteDecimals: 18,
  },
} as const;
