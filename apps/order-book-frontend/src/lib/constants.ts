import type { Address } from "viem";

export const API_URL =
  process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3000";

export const USD_ADDRESS: Address =
  "0x1111111111111111111111111111111111111111";

const TOKEN_NAMES: Record<string, string> = {
  "0x1111111111111111111111111111111111111111": "USD",
  "0x2222222222222222222222222222222222222222": "GOLD",
  "0x3333333333333333333333333333333333333333": "WTIOIL",
};

export function tokenName(address: string): string {
  return TOKEN_NAMES[address.toLowerCase()] ?? address.slice(0, 6);
}
