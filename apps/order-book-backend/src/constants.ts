import type { Address } from "viem";
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
  process.env.BUN_PUBLIC_EXCHANGE_ADDRESS as Address;

export const EIP712_TYPES = {
  Initialize: [
    { name: "account", type: "bytes32" },
    { name: "expiry", type: "uint40" },
    { name: "rootKeyType", type: "uint8" },
    { name: "keyType", type: "uint8" },
    { name: "permissions", type: "uint8" },
    { name: "rootPublicKey", type: "bytes" },
    { name: "publicKey", type: "bytes" },
  ],
  Authorize: [
    { name: "account", type: "bytes32" },
    { name: "expiry", type: "uint40" },
    { name: "keyType", type: "uint8" },
    { name: "permissions", type: "uint8" },
    { name: "publicKey", type: "bytes" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
  Revoke: [
    { name: "account", type: "bytes32" },
    { name: "keyId", type: "uint64" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
  CloseOrder: [
    { name: "orderId", type: "uint64" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
  LimitOrder: [
    { name: "quantity", type: "uint64" },
    { name: "instrumentId", type: "uint64" },
    { name: "price", type: "uint64" },
    { name: "bidOrAsk", type: "uint8" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
  MarketOrder: [
    { name: "quantity", type: "uint64" },
    { name: "minReceivedQuantity", type: "uint64" },
    { name: "instrumentId", type: "uint64" },
    { name: "bidOrAsk", type: "uint8" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
  Deposit: [
    { name: "asset", type: "address" },
    { name: "amount", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
  Withdrawal: [
    { name: "asset", type: "address" },
    { name: "amount", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
} as const;

export const EXCHANGE_ABI = [
  {
    type: "constructor",
    inputs: [{ name: "_scheduler", type: "address", internalType: "address" }],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "DOMAIN_SEPARATOR",
    inputs: [],
    outputs: [{ name: "", type: "bytes32", internalType: "bytes32" }],
    stateMutability: "view",
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
          {
            name: "signatures",
            type: "tuple[]",
            internalType: "struct Signature[]",
            components: [
              { name: "account", type: "bytes32", internalType: "bytes32" },
              { name: "keyId", type: "uint64", internalType: "uint64" },
              { name: "rawSignature", type: "bytes", internalType: "bytes" },
            ],
          },
        ],
      },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  { type: "error", name: "AlreadyInitialized", inputs: [] },
  { type: "error", name: "InstrumentAlreadyExists", inputs: [] },
  { type: "error", name: "InsufficientBalance", inputs: [] },
  { type: "error", name: "InvalidInstrument", inputs: [] },
  { type: "error", name: "InvalidMutation", inputs: [] },
  { type: "error", name: "InvalidNonce", inputs: [] },
  { type: "error", name: "InvalidSignature", inputs: [] },
  { type: "error", name: "InvalidTick", inputs: [] },
  { type: "error", name: "KeyExpired", inputs: [] },
  { type: "error", name: "KeyNotFound", inputs: [] },
  { type: "error", name: "LengthMismatch", inputs: [] },
  { type: "error", name: "MissingAuthorizePermission", inputs: [] },
  { type: "error", name: "MutationsOutOfOrder", inputs: [] },
  { type: "error", name: "OrderNotFound", inputs: [] },
  { type: "error", name: "SignatureExpired", inputs: [] },
  { type: "error", name: "SlippageExceeded", inputs: [] },
  { type: "error", name: "TickPartiallyFilled", inputs: [] },
  { type: "error", name: "Unauthorized", inputs: [] },
] as const;
