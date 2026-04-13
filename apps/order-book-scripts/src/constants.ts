import type { Address } from "viem";

export const API_URL = process.env.API_URL ?? "http://localhost:3000";
export const CHAIN_ID = Number(process.env.CHAIN_ID ?? "31337");
export const EXCHANGE_ADDRESS = (process.env.EXCHANGE_ADDRESS ??
  "0x5fbdb2315678afecb367f032d93f642f64180aa3") as Address;

export const USD: Address = "0x1111111111111111111111111111111111111111";
export const GOLD: Address = "0x2222222222222222222222222222222222222222";
export const WTIOIL: Address = "0x3333333333333333333333333333333333333333";

export const GOLD_Q32_PRICE = 21_110_623_253_299_200n;
export const WTIOIL_Q32_PRICE = 16_492_674_416_640n;

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
  Deposit: [
    { name: "asset", type: "address" },
    { name: "amount", type: "uint256" },
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
} as const;
