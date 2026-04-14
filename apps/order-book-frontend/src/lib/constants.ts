import type { Address } from "viem";

export const Q32 = 1n << 32n;

export const API_URL =
  process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3000";

export const USD_ADDRESS: Address =
  "0x2222222222222222222222222222222222222222";
