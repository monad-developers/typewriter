import type { Address } from "viem";
export { EIP712_TYPES } from "order-book-sdk";

export const EXCHANGE_ADDRESS = (process.env.BUN_PUBLIC_EXCHANGE_ADDRESS ??
  "0x0000000000000000000000000000000000000000") as Address;

const CHAIN_ID = Number(process.env.BUN_PUBLIC_CHAIN_ID ?? "31337");

export const EIP712_DOMAIN = {
  name: "Exchange" as const,
  version: "1" as const,
  chainId: CHAIN_ID,
  verifyingContract: EXCHANGE_ADDRESS,
};

export const MAX_DEADLINE =
  0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffn;
