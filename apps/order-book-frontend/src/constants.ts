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

const E18 = 1000000000000000000n;

export const TICK_SCALE = 10_000_000;

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
        0: 50000n * E18,
        1: 8000n * E18,
        2: 200000n * E18,
        3: 100000n * E18,
        4: 1500000n * E18,
      },
      orders: [
        { quantity: 1000n * E18, marketId: 0, tickId: 1380950, tickVolume: 3, side: 0 },
        { quantity: 5000n * E18, marketId: 1, tickId: 119770, tickVolume: 1, side: 1 },
        { quantity: 2000n * E18, marketId: 3, tickId: 66228, tickVolume: 2, side: 0 },
      ],
    },
    {
      nonce: 3,
      balances: {
        0: 120000n * E18,
        1: 3000n * E18,
        2: 0n,
        3: 500000n * E18,
        4: 800000n * E18,
      },
      orders: [
        { quantity: 2000n * E18, marketId: 0, tickId: 1381050, tickVolume: 2, side: 1 },
        { quantity: 8000n * E18, marketId: 2, tickId: 108705, tickVolume: 1, side: 1 },
      ],
    },
    {
      nonce: 1,
      balances: {
        0: 0n,
        1: 15000n * E18,
        2: 1000000n * E18,
        3: 0n,
        4: 0n,
      },
      orders: [],
    },
    {
      nonce: 2,
      balances: {
        0: 75000n * E18,
        1: 22000n * E18,
        2: 450000n * E18,
        3: 300000n * E18,
        4: 2000000n * E18,
      },
      orders: [
        { quantity: 3000n * E18, marketId: 0, tickId: 1380870, tickVolume: 1, side: 0 },
        { quantity: 10000n * E18, marketId: 1, tickId: 119754, tickVolume: 2, side: 0 },
        { quantity: 50000n * E18, marketId: 3, tickId: 66195, tickVolume: 3, side: 0 },
      ],
    },
    {
      nonce: 4,
      balances: {
        0: 30000n * E18,
        1: 5500n * E18,
        2: 80000n * E18,
        3: 900000n * E18,
        4: 600000n * E18,
      },
      orders: [
        { quantity: 15000n * E18, marketId: 2, tickId: 108695, tickVolume: 4, side: 0 },
        { quantity: 4000n * E18, marketId: 3, tickId: 66231, tickVolume: 1, side: 1 },
      ],
    },
  ],
  instruments: [
    {
      baseId: 0,
      quoteId: 1,
      bids: {
        1380950: { quantity: 800n * E18, remainingQuantity: 750n * E18, volume: 3 },
        1380920: { quantity: 600n * E18, remainingQuantity: 600n * E18, volume: 2 },
        1380900: { quantity: 1200n * E18, remainingQuantity: 1200n * E18, volume: 2 },
        1380870: { quantity: 500n * E18, remainingQuantity: 500n * E18, volume: 1 },
        1380500: { quantity: 3000n * E18, remainingQuantity: 2800n * E18, volume: 4 },
        1380400: { quantity: 2500n * E18, remainingQuantity: 2500n * E18, volume: 3 },
        1380350: { quantity: 4000n * E18, remainingQuantity: 4000n * E18, volume: 5 },
        1380200: { quantity: 1800n * E18, remainingQuantity: 1800n * E18, volume: 2 },
        1380000: { quantity: 8000n * E18, remainingQuantity: 7500n * E18, volume: 6 },
        1379800: { quantity: 6000n * E18, remainingQuantity: 6000n * E18, volume: 4 },
        1379700: { quantity: 10000n * E18, remainingQuantity: 10000n * E18, volume: 7 },
        1379500: { quantity: 5000n * E18, remainingQuantity: 5000n * E18, volume: 3 },
        1378500: { quantity: 25000n * E18, remainingQuantity: 25000n * E18, volume: 8 },
        1378000: { quantity: 30000n * E18, remainingQuantity: 30000n * E18, volume: 10 },
        1377800: { quantity: 15000n * E18, remainingQuantity: 15000n * E18, volume: 6 },
        1377500: { quantity: 20000n * E18, remainingQuantity: 20000n * E18, volume: 5 },
      },
      asks: {
        1381050: { quantity: 900n * E18, remainingQuantity: 850n * E18, volume: 2 },
        1381080: { quantity: 700n * E18, remainingQuantity: 700n * E18, volume: 2 },
        1381100: { quantity: 1100n * E18, remainingQuantity: 1100n * E18, volume: 3 },
        1381130: { quantity: 600n * E18, remainingQuantity: 600n * E18, volume: 1 },
        1381500: { quantity: 3500n * E18, remainingQuantity: 3200n * E18, volume: 4 },
        1381600: { quantity: 2800n * E18, remainingQuantity: 2800n * E18, volume: 3 },
        1381650: { quantity: 4500n * E18, remainingQuantity: 4500n * E18, volume: 5 },
        1381800: { quantity: 2000n * E18, remainingQuantity: 2000n * E18, volume: 2 },
        1382000: { quantity: 9000n * E18, remainingQuantity: 8500n * E18, volume: 6 },
        1382200: { quantity: 7000n * E18, remainingQuantity: 7000n * E18, volume: 5 },
        1382300: { quantity: 11000n * E18, remainingQuantity: 11000n * E18, volume: 7 },
        1382500: { quantity: 6000n * E18, remainingQuantity: 6000n * E18, volume: 4 },
        1383500: { quantity: 20000n * E18, remainingQuantity: 20000n * E18, volume: 9 },
        1384000: { quantity: 35000n * E18, remainingQuantity: 35000n * E18, volume: 11 },
        1384200: { quantity: 18000n * E18, remainingQuantity: 18000n * E18, volume: 7 },
        1384500: { quantity: 22000n * E18, remainingQuantity: 22000n * E18, volume: 6 },
      },
    },
    {
      baseId: 2,
      quoteId: 1,
      bids: {
        119754: { quantity: 5000n * E18, remainingQuantity: 4800n * E18, volume: 3 },
        119750: { quantity: 3500n * E18, remainingQuantity: 3500n * E18, volume: 2 },
        119748: { quantity: 2000n * E18, remainingQuantity: 2000n * E18, volume: 1 },
        119720: { quantity: 12000n * E18, remainingQuantity: 11500n * E18, volume: 5 },
        119710: { quantity: 8000n * E18, remainingQuantity: 8000n * E18, volume: 3 },
        119702: { quantity: 15000n * E18, remainingQuantity: 15000n * E18, volume: 4 },
        119680: { quantity: 6000n * E18, remainingQuantity: 6000n * E18, volume: 2 },
        119650: { quantity: 25000n * E18, remainingQuantity: 24000n * E18, volume: 6 },
        119640: { quantity: 18000n * E18, remainingQuantity: 18000n * E18, volume: 4 },
        119630: { quantity: 30000n * E18, remainingQuantity: 30000n * E18, volume: 7 },
        119600: { quantity: 20000n * E18, remainingQuantity: 20000n * E18, volume: 5 },
        119470: { quantity: 80000n * E18, remainingQuantity: 80000n * E18, volume: 10 },
        119450: { quantity: 60000n * E18, remainingQuantity: 60000n * E18, volume: 8 },
        119400: { quantity: 100000n * E18, remainingQuantity: 100000n * E18, volume: 12 },
      },
      asks: {
        119766: { quantity: 4500n * E18, remainingQuantity: 4200n * E18, volume: 3 },
        119770: { quantity: 3000n * E18, remainingQuantity: 3000n * E18, volume: 2 },
        119772: { quantity: 2500n * E18, remainingQuantity: 2500n * E18, volume: 1 },
        119800: { quantity: 10000n * E18, remainingQuantity: 9500n * E18, volume: 4 },
        119810: { quantity: 7000n * E18, remainingQuantity: 7000n * E18, volume: 3 },
        119818: { quantity: 14000n * E18, remainingQuantity: 14000n * E18, volume: 5 },
        119840: { quantity: 5500n * E18, remainingQuantity: 5500n * E18, volume: 2 },
        119870: { quantity: 22000n * E18, remainingQuantity: 21000n * E18, volume: 6 },
        119880: { quantity: 16000n * E18, remainingQuantity: 16000n * E18, volume: 4 },
        119890: { quantity: 28000n * E18, remainingQuantity: 28000n * E18, volume: 7 },
        119920: { quantity: 18000n * E18, remainingQuantity: 18000n * E18, volume: 5 },
        120050: { quantity: 70000n * E18, remainingQuantity: 70000n * E18, volume: 9 },
        120070: { quantity: 55000n * E18, remainingQuantity: 55000n * E18, volume: 7 },
        120120: { quantity: 90000n * E18, remainingQuantity: 90000n * E18, volume: 11 },
      },
    },
    {
      baseId: 3,
      quoteId: 1,
      bids: {
        108695: { quantity: 4000n * E18, remainingQuantity: 3800n * E18, volume: 4 },
        108692: { quantity: 3000n * E18, remainingQuantity: 3000n * E18, volume: 2 },
        108690: { quantity: 2200n * E18, remainingQuantity: 2200n * E18, volume: 1 },
        108660: { quantity: 10000n * E18, remainingQuantity: 9500n * E18, volume: 5 },
        108650: { quantity: 7500n * E18, remainingQuantity: 7500n * E18, volume: 3 },
        108648: { quantity: 12000n * E18, remainingQuantity: 12000n * E18, volume: 4 },
        108620: { quantity: 5000n * E18, remainingQuantity: 5000n * E18, volume: 2 },
        108600: { quantity: 20000n * E18, remainingQuantity: 19000n * E18, volume: 6 },
        108590: { quantity: 15000n * E18, remainingQuantity: 15000n * E18, volume: 4 },
        108580: { quantity: 25000n * E18, remainingQuantity: 25000n * E18, volume: 7 },
        108550: { quantity: 18000n * E18, remainingQuantity: 18000n * E18, volume: 5 },
        108440: { quantity: 60000n * E18, remainingQuantity: 60000n * E18, volume: 9 },
        108420: { quantity: 45000n * E18, remainingQuantity: 45000n * E18, volume: 7 },
        108400: { quantity: 80000n * E18, remainingQuantity: 80000n * E18, volume: 11 },
      },
      asks: {
        108705: { quantity: 3500n * E18, remainingQuantity: 3300n * E18, volume: 3 },
        108708: { quantity: 2800n * E18, remainingQuantity: 2800n * E18, volume: 2 },
        108710: { quantity: 1800n * E18, remainingQuantity: 1800n * E18, volume: 1 },
        108740: { quantity: 9000n * E18, remainingQuantity: 8500n * E18, volume: 4 },
        108750: { quantity: 6500n * E18, remainingQuantity: 6500n * E18, volume: 3 },
        108752: { quantity: 11000n * E18, remainingQuantity: 11000n * E18, volume: 5 },
        108780: { quantity: 4500n * E18, remainingQuantity: 4500n * E18, volume: 2 },
        108800: { quantity: 18000n * E18, remainingQuantity: 17000n * E18, volume: 6 },
        108810: { quantity: 13000n * E18, remainingQuantity: 13000n * E18, volume: 4 },
        108820: { quantity: 22000n * E18, remainingQuantity: 22000n * E18, volume: 7 },
        108850: { quantity: 16000n * E18, remainingQuantity: 16000n * E18, volume: 5 },
        108960: { quantity: 55000n * E18, remainingQuantity: 55000n * E18, volume: 8 },
        108980: { quantity: 40000n * E18, remainingQuantity: 40000n * E18, volume: 6 },
        109000: { quantity: 75000n * E18, remainingQuantity: 75000n * E18, volume: 10 },
      },
    },
    {
      baseId: 4,
      quoteId: 1,
      bids: {
        66222: { quantity: 8000n * E18, remainingQuantity: 7500n * E18, volume: 4 },
        66220: { quantity: 6000n * E18, remainingQuantity: 6000n * E18, volume: 3 },
        66219: { quantity: 4000n * E18, remainingQuantity: 4000n * E18, volume: 2 },
        66215: { quantity: 3000n * E18, remainingQuantity: 3000n * E18, volume: 1 },
        66195: { quantity: 20000n * E18, remainingQuantity: 19000n * E18, volume: 6 },
        66192: { quantity: 15000n * E18, remainingQuantity: 15000n * E18, volume: 4 },
        66190: { quantity: 25000n * E18, remainingQuantity: 25000n * E18, volume: 5 },
        66180: { quantity: 10000n * E18, remainingQuantity: 10000n * E18, volume: 3 },
        66160: { quantity: 40000n * E18, remainingQuantity: 38000n * E18, volume: 7 },
        66158: { quantity: 30000n * E18, remainingQuantity: 30000n * E18, volume: 5 },
        66155: { quantity: 50000n * E18, remainingQuantity: 50000n * E18, volume: 8 },
        66140: { quantity: 35000n * E18, remainingQuantity: 35000n * E18, volume: 6 },
        66060: { quantity: 120000n * E18, remainingQuantity: 120000n * E18, volume: 12 },
        66050: { quantity: 90000n * E18, remainingQuantity: 90000n * E18, volume: 10 },
        66040: { quantity: 150000n * E18, remainingQuantity: 150000n * E18, volume: 14 },
        66020: { quantity: 80000n * E18, remainingQuantity: 80000n * E18, volume: 8 },
      },
      asks: {
        66228: { quantity: 7000n * E18, remainingQuantity: 6500n * E18, volume: 3 },
        66230: { quantity: 5500n * E18, remainingQuantity: 5500n * E18, volume: 3 },
        66231: { quantity: 3500n * E18, remainingQuantity: 3500n * E18, volume: 2 },
        66235: { quantity: 2500n * E18, remainingQuantity: 2500n * E18, volume: 1 },
        66255: { quantity: 18000n * E18, remainingQuantity: 17000n * E18, volume: 5 },
        66258: { quantity: 13000n * E18, remainingQuantity: 13000n * E18, volume: 4 },
        66260: { quantity: 22000n * E18, remainingQuantity: 22000n * E18, volume: 6 },
        66270: { quantity: 9000n * E18, remainingQuantity: 9000n * E18, volume: 3 },
        66290: { quantity: 35000n * E18, remainingQuantity: 33000n * E18, volume: 7 },
        66292: { quantity: 28000n * E18, remainingQuantity: 28000n * E18, volume: 5 },
        66295: { quantity: 45000n * E18, remainingQuantity: 45000n * E18, volume: 8 },
        66310: { quantity: 30000n * E18, remainingQuantity: 30000n * E18, volume: 6 },
        66390: { quantity: 100000n * E18, remainingQuantity: 100000n * E18, volume: 11 },
        66400: { quantity: 80000n * E18, remainingQuantity: 80000n * E18, volume: 9 },
        66410: { quantity: 130000n * E18, remainingQuantity: 130000n * E18, volume: 13 },
        66430: { quantity: 70000n * E18, remainingQuantity: 70000n * E18, volume: 7 },
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
