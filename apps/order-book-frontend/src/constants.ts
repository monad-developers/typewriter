import type { Address } from "viem";

export const Q32 = 1n << 32n;

export type Currency = {
  code: string;
  name: string;
  symbol: string;
  country: string;
  flag: string;
  decimals: number;
  symbolPosition: "before" | "after";
  rateToUsd: number;
  address: Address;
};

export function formatCurrency(amount: string, currency: Currency): string {
  return currency.symbolPosition === "after"
    ? `${amount}${currency.symbol}`
    : `${currency.symbol}${amount}`;
}

export const CURRENCIES: Currency[] = [
  {
    code: "CNY",
    name: "Chinese Yuan",
    symbol: "\u00a5",
    country: "China",
    flag: "\ud83c\udde8\ud83c\uddf3",
    decimals: 2,
    symbolPosition: "after",
    rateToUsd: 7.24,
    address: "0x1111111111111111111111111111111111111111",
  },
  {
    code: "USD",
    name: "US Dollar",
    symbol: "$",
    country: "United States",
    flag: "\ud83c\uddfa\ud83c\uddf8",
    decimals: 2,
    symbolPosition: "before",
    rateToUsd: 1,
    address: "0x2222222222222222222222222222222222222222",
  },
  {
    code: "INR",
    name: "Indian Rupee",
    symbol: "\u20b9",
    country: "India",
    flag: "\ud83c\uddee\ud83c\uddf3",
    decimals: 2,
    symbolPosition: "before",
    rateToUsd: 83.5,
    address: "0x3333333333333333333333333333333333333333",
  },
  {
    code: "RUB",
    name: "Russian Ruble",
    symbol: "\u20bd",
    country: "Russia",
    flag: "\ud83c\uddf7\ud83c\uddfa",
    decimals: 2,
    symbolPosition: "after",
    rateToUsd: 92,
    address: "0x4444444444444444444444444444444444444444",
  },
  {
    code: "JPY",
    name: "Japanese Yen",
    symbol: "\u00a5",
    country: "Japan",
    flag: "\ud83c\uddef\ud83c\uddf5",
    decimals: 0,
    symbolPosition: "before",
    rateToUsd: 151,
    address: "0x5555555555555555555555555555555555555555",
  },
];
