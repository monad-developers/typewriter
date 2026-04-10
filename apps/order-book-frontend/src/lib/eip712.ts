import type { Address } from "viem";

const EXCHANGE_ADDRESS = // @ts-expect-error
  (process.env.BUN_PUBLIC_EXCHANGE_ADDRESS ??
    "0x0000000000000000000000000000000000000000") as Address;

const CHAIN_ID = Number(
  // @ts-expect-error
  process.env.BUN_PUBLIC_CHAIN_ID ?? "31337",
);

export const EIP712_DOMAIN = {
  name: "Exchange" as const,
  version: "1" as const,
  chainId: CHAIN_ID,
  verifyingContract: EXCHANGE_ADDRESS,
};

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
  Deposit: [
    { name: "asset", type: "address" },
    { name: "amount", type: "uint256" },
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
  LimitOrder: [
    { name: "quantity", type: "uint64" },
    { name: "instrumentId", type: "uint64" },
    { name: "price", type: "uint64" },
    { name: "bidOrAsk", type: "uint8" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
  CloseOrder: [
    { name: "orderId", type: "uint64" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
} as const;

export const MAX_DEADLINE =
  0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffn;
