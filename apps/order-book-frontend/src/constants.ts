import { extractChain } from "viem";
import { anvil, monadTestnet } from "viem/chains";

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
  process.env.BUN_PUBLIC_EXCHANGE_ADDRESS as `0x${string}`;

// ---------------------------------------------------------------------------
// Currencies — top 5 countries by energy consumption
// ---------------------------------------------------------------------------

export type Currency = {
  code: string;
  name: string;
  symbol: string;
  country: string;
  flag: string;
  decimals: number;
  symbolPosition: "before" | "after";
  /** Approximate units per 1 USD (for seeding initial exchange rates) */
  rateToUsd: number;
};

export function formatCurrency(amount: string, currency: Currency): string {
  return currency.symbolPosition === "after"
    ? `${amount}${currency.symbol}`
    : `${currency.symbol}${amount}`;
}

export const CURRENCIES: Currency[] = [
  { code: "CNY", name: "Chinese Yuan",      symbol: "\u00a5", country: "China",         flag: "\ud83c\udde8\ud83c\uddf3", decimals: 2, symbolPosition: "after",  rateToUsd: 7.24 },
  { code: "USD", name: "US Dollar",         symbol: "$",      country: "United States", flag: "\ud83c\uddfa\ud83c\uddf8", decimals: 2, symbolPosition: "before", rateToUsd: 1 },
  { code: "INR", name: "Indian Rupee",      symbol: "\u20b9", country: "India",         flag: "\ud83c\uddee\ud83c\uddf3", decimals: 2, symbolPosition: "before", rateToUsd: 83.5 },
  { code: "RUB", name: "Russian Ruble",     symbol: "\u20bd", country: "Russia",        flag: "\ud83c\uddf7\ud83c\uddfa", decimals: 2, symbolPosition: "after",  rateToUsd: 92 },
  { code: "JPY", name: "Japanese Yen",      symbol: "\u00a5", country: "Japan",         flag: "\ud83c\uddef\ud83c\uddf5", decimals: 0, symbolPosition: "before", rateToUsd: 151 },
];

export const EXCHANGE_ABI = [
  {
    type: "constructor",
    inputs: [{ name: "_scheduler", type: "address", internalType: "address" }],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "execute",
    inputs: [
      {
        name: "params",
        type: "tuple",
        internalType: "struct ExecuteParams",
        components: [
          {
            name: "mutations",
            type: "uint8[]",
            internalType: "enum Mutation[]",
          },
          { name: "mutationData", type: "bytes[]", internalType: "bytes[]" },
          { name: "v", type: "uint8[]", internalType: "uint8[]" },
          { name: "r", type: "bytes32[]", internalType: "bytes32[]" },
          { name: "s", type: "bytes32[]", internalType: "bytes32[]" },
        ],
      },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  { type: "error", name: "FillPriceExceedsLimit", inputs: [] },
  { type: "error", name: "InsufficientBalance", inputs: [] },
  { type: "error", name: "InvalidAccount", inputs: [] },
  { type: "error", name: "InvalidInstrument", inputs: [] },
  { type: "error", name: "InvalidMutation", inputs: [] },
  { type: "error", name: "InvalidTick", inputs: [] },
  { type: "error", name: "LengthMismatch", inputs: [] },
  { type: "error", name: "OrderNotFound", inputs: [] },
  { type: "error", name: "SlippageExceeded", inputs: [] },
  { type: "error", name: "TickPartiallyFilled", inputs: [] },
  { type: "error", name: "Unauthorized", inputs: [] },
] as const;
