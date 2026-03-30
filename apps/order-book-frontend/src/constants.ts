import { extractChain } from "viem";
import { anvil, monadTestnet } from "viem/chains";
import type { State } from "./api";

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
  {
    code: "CNY",
    name: "Chinese Yuan",
    symbol: "\u00a5",
    country: "China",
    flag: "\ud83c\udde8\ud83c\uddf3",
    decimals: 2,
    symbolPosition: "after",
    rateToUsd: 7.24,
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
  },
];

export const EXAMPLE_STATE: State<bigint> = {
  assets: [
    "0x1111111111111111111111111111111111111111",
    "0x2222222222222222222222222222222222222222",
    "0x3333333333333333333333333333333333333333",
    "0x4444444444444444444444444444444444444444",
    "0x5555555555555555555555555555555555555555",
  ],
  accounts: [
    {
      nonce: 5,
      balances: {
        0: 50000000000000000000000n,
        1: 8000000000000000000000n,
        2: 200000000000000000000000n,
        3: 100000000000000000000000n,
        4: 1500000000000000000000000n,
      },
      orders: [
        {
          quantity: 1000000000000000000000n,
          marketId: 0,
          tickId: 1381,
          tickVolume: 3,
          side: 0,
        },
        {
          quantity: 5000000000000000000000n,
          marketId: 1,
          tickId: 120,
          tickVolume: 1,
          side: 1,
        },
      ],
    },
    {
      nonce: 3,
      balances: {
        0: 120000000000000000000000n,
        1: 3000000000000000000000n,
        2: 0n,
        3: 500000000000000000000000n,
        4: 800000000000000000000000n,
      },
      orders: [
        {
          quantity: 2000000000000000000000n,
          marketId: 0,
          tickId: 1385,
          tickVolume: 2,
          side: 1,
        },
      ],
    },
    {
      nonce: 1,
      balances: {
        0: 0n,
        1: 15000000000000000000000n,
        2: 1000000000000000000000000n,
        3: 0n,
        4: 0n,
      },
      orders: [],
    },
  ],
  instruments: [
    {
      baseId: 0,
      quoteId: 1,
      bids: {
        1375: {
          quantity: 3000000000000000000000n,
          remainingQuantity: 2800000000000000000000n,
          volume: 4,
        },
        1370: {
          quantity: 5000000000000000000000n,
          remainingQuantity: 5000000000000000000000n,
          volume: 2,
        },
        1360: {
          quantity: 10000000000000000000000n,
          remainingQuantity: 10000000000000000000000n,
          volume: 6,
        },
        1340: {
          quantity: 25000000000000000000000n,
          remainingQuantity: 25000000000000000000000n,
          volume: 8,
        },
      },
      asks: {
        1385: {
          quantity: 2000000000000000000000n,
          remainingQuantity: 1500000000000000000000n,
          volume: 3,
        },
        1390: {
          quantity: 4000000000000000000000n,
          remainingQuantity: 4000000000000000000000n,
          volume: 2,
        },
        1400: {
          quantity: 8000000000000000000000n,
          remainingQuantity: 8000000000000000000000n,
          volume: 5,
        },
        1420: {
          quantity: 20000000000000000000000n,
          remainingQuantity: 20000000000000000000000n,
          volume: 7,
        },
      },
    },
    {
      baseId: 2,
      quoteId: 1,
      bids: {
        118: {
          quantity: 50000000000000000000000n,
          remainingQuantity: 50000000000000000000000n,
          volume: 3,
        },
        115: {
          quantity: 100000000000000000000000n,
          remainingQuantity: 100000000000000000000000n,
          volume: 5,
        },
        110: {
          quantity: 200000000000000000000000n,
          remainingQuantity: 200000000000000000000000n,
          volume: 8,
        },
      },
      asks: {
        122: {
          quantity: 40000000000000000000000n,
          remainingQuantity: 40000000000000000000000n,
          volume: 2,
        },
        125: {
          quantity: 80000000000000000000000n,
          remainingQuantity: 80000000000000000000000n,
          volume: 4,
        },
        130: {
          quantity: 150000000000000000000000n,
          remainingQuantity: 150000000000000000000000n,
          volume: 6,
        },
      },
    },
    {
      baseId: 3,
      quoteId: 1,
      bids: {
        108: {
          quantity: 30000000000000000000000n,
          remainingQuantity: 30000000000000000000000n,
          volume: 2,
        },
        105: {
          quantity: 80000000000000000000000n,
          remainingQuantity: 80000000000000000000000n,
          volume: 4,
        },
        100: {
          quantity: 150000000000000000000000n,
          remainingQuantity: 150000000000000000000000n,
          volume: 7,
        },
      },
      asks: {
        112: {
          quantity: 25000000000000000000000n,
          remainingQuantity: 25000000000000000000000n,
          volume: 3,
        },
        115: {
          quantity: 60000000000000000000000n,
          remainingQuantity: 60000000000000000000000n,
          volume: 5,
        },
        120: {
          quantity: 120000000000000000000000n,
          remainingQuantity: 120000000000000000000000n,
          volume: 6,
        },
      },
    },
    {
      baseId: 4,
      quoteId: 1,
      bids: {
        65: {
          quantity: 500000000000000000000000n,
          remainingQuantity: 500000000000000000000000n,
          volume: 5,
        },
        64: {
          quantity: 1000000000000000000000000n,
          remainingQuantity: 1000000000000000000000000n,
          volume: 8,
        },
        62: {
          quantity: 2000000000000000000000000n,
          remainingQuantity: 2000000000000000000000000n,
          volume: 10,
        },
      },
      asks: {
        67: {
          quantity: 400000000000000000000000n,
          remainingQuantity: 400000000000000000000000n,
          volume: 4,
        },
        68: {
          quantity: 800000000000000000000000n,
          remainingQuantity: 800000000000000000000000n,
          volume: 6,
        },
        70: {
          quantity: 1500000000000000000000000n,
          remainingQuantity: 1500000000000000000000000n,
          volume: 9,
        },
      },
    },
  ],
};

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
