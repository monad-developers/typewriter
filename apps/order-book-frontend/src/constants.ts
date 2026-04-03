import type { Address } from "viem";
import { extractChain } from "viem";
import { anvil, monadTestnet } from "viem/chains";
import type { State } from "./exchange";

const chains = [anvil, monadTestnet] as const;

// @ts-expect-error
if (!process.env.BUN_PUBLIC_CHAIN_ID)
  throw new Error("BUN_PUBLIC_CHAIN_ID env var is required");
// @ts-expect-error
export const CHAIN_ID = Number(process.env.BUN_PUBLIC_CHAIN_ID);

export const CHAIN = extractChain({
  chains,
  id: CHAIN_ID as (typeof chains)[number]["id"],
}) as typeof anvil | typeof monadTestnet;

// @ts-expect-error
if (!process.env.BUN_PUBLIC_RPC_URL)
  throw new Error("BUN_PUBLIC_RPC_URL env var is required");
// @ts-expect-error
export const RPC_URL = process.env.BUN_PUBLIC_RPC_URL;

// @ts-expect-error
if (!process.env.BUN_PUBLIC_EXCHANGE_ADDRESS)
  throw new Error("BUN_PUBLIC_EXCHANGE_ADDRESS env var is required");
export const EXCHANGE_ADDRESS = // @ts-expect-error
  process.env.BUN_PUBLIC_EXCHANGE_ADDRESS as Address;

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

function priceQ32(rateToUsd: number): bigint {
  return BigInt(Math.floor((1 / rateToUsd) * Number(Q32)));
}

function buildBook(
  midPrice: bigint,
  step: bigint,
  levels: number,
): {
  bids: Record<
    number,
    { quantity: bigint; remainingQuantity: bigint; volume: number }
  >;
  asks: Record<
    number,
    { quantity: bigint; remainingQuantity: bigint; volume: number }
  >;
} {
  const bids: Record<
    number,
    { quantity: bigint; remainingQuantity: bigint; volume: number }
  > = {};
  const asks: Record<
    number,
    { quantity: bigint; remainingQuantity: bigint; volume: number }
  > = {};

  for (let i = 1; i <= levels; i++) {
    const qty = BigInt(100 * i);
    const bidPrice = midPrice - step * BigInt(i);
    const askPrice = midPrice + step * BigInt(i);
    bids[Number(bidPrice)] = {
      quantity: qty,
      remainingQuantity: qty,
      volume: i,
    };
    asks[Number(askPrice)] = {
      quantity: qty,
      remainingQuantity: qty,
      volume: i,
    };
  }

  return { bids, asks };
}

const ACCOUNT_ADDRESSES: Address[] = [
  "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266",
  "0x70997970c51812dc3a010c7d01b50e0d17dc79c8",
  "0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc",
  "0x90f79bf6eb2c4f870365e785982e1f101e93b906",
  "0x15d34aaf54267db7d7c367839aaf71a00a2c6a65",
];

export const EXAMPLE_STATE: State<bigint> = (() => {
  const USD = CURRENCIES[1]!.address;
  const instruments: State<bigint>["instruments"] = {};

  const pairIndices = [0, 2, 3, 4];
  for (let i = 0; i < pairIndices.length; i++) {
    const currency = CURRENCIES[pairIndices[i]!]!;
    const mid = priceQ32(currency.rateToUsd);
    const step = mid / 1000n || 1n;
    const book = buildBook(mid, step, 8);
    instruments[i] = {
      base: currency.address,
      baseLotExp: 0,
      quote: USD,
      quoteLotExp: 0,
      ...book,
    };
  }

  const accounts: State<bigint>["accounts"] = {};
  for (const addr of ACCOUNT_ADDRESSES) {
    const balances: Record<Address, bigint> = {};
    for (const c of CURRENCIES) {
      balances[c.address] = BigInt(Math.floor(50000 / c.rateToUsd));
    }
    accounts[addr] = { nonce: 0n, balances, orders: [] };
  }

  return { accounts, instruments };
})();
