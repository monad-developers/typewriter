import type { Address } from "viem";
import { signTypedData } from "viem/accounts";
import type { Account } from "../contexts/AccountContext";

const EXCHANGE_ADDRESS = // @ts-expect-error
  (process.env.BUN_PUBLIC_EXCHANGE_ADDRESS ?? "0x0000000000000000000000000000000000000000") as Address;

const CHAIN_ID = Number(
  // @ts-expect-error
  process.env.BUN_PUBLIC_CHAIN_ID ?? "31337",
);

const EIP712_DOMAIN = {
  name: "Exchange" as const,
  version: "1" as const,
  chainId: CHAIN_ID,
  verifyingContract: EXCHANGE_ADDRESS,
};

const EIP712_TYPES = {
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
  Deposit: [
    { name: "asset", type: "address" },
    { name: "amount", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
} as const;

const FAR_DEADLINE = BigInt("0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff");

export async function signMarketOrder(
  account: Account,
  nonce: bigint,
  params: { quantity: bigint; minReceivedQuantity: bigint; instrumentId: number; bidOrAsk: 0 | 1 },
) {
  const signature = await signTypedData({
    privateKey: account.privateKey,
    domain: EIP712_DOMAIN,
    types: EIP712_TYPES,
    primaryType: "MarketOrder",
    message: {
      quantity: params.quantity,
      minReceivedQuantity: params.minReceivedQuantity,
      instrumentId: BigInt(params.instrumentId),
      bidOrAsk: params.bidOrAsk,
      nonce,
      deadline: FAR_DEADLINE,
    },
  });

  return {
    ...params,
    quantity: params.quantity.toString(),
    minReceivedQuantity: params.minReceivedQuantity.toString(),
    account: account.address,
    nonce: nonce.toString(),
    deadline: FAR_DEADLINE.toString(),
    signature,
  };
}

export async function signLimitOrder(
  account: Account,
  nonce: bigint,
  params: { quantity: bigint; instrumentId: number; price: bigint; bidOrAsk: 0 | 1 },
) {
  const signature = await signTypedData({
    privateKey: account.privateKey,
    domain: EIP712_DOMAIN,
    types: EIP712_TYPES,
    primaryType: "LimitOrder",
    message: {
      quantity: params.quantity,
      instrumentId: BigInt(params.instrumentId),
      price: params.price,
      bidOrAsk: params.bidOrAsk,
      nonce,
      deadline: FAR_DEADLINE,
    },
  });

  return {
    ...params,
    quantity: params.quantity.toString(),
    instrumentId: params.instrumentId,
    price: params.price.toString(),
    account: account.address,
    nonce: nonce.toString(),
    deadline: FAR_DEADLINE.toString(),
    signature,
  };
}

export async function signCloseOrder(
  account: Account,
  nonce: bigint,
  params: { orderId: number },
) {
  const signature = await signTypedData({
    privateKey: account.privateKey,
    domain: EIP712_DOMAIN,
    types: EIP712_TYPES,
    primaryType: "CloseOrder",
    message: {
      orderId: BigInt(params.orderId),
      nonce,
      deadline: FAR_DEADLINE,
    },
  });

  return {
    ...params,
    account: account.address,
    nonce: nonce.toString(),
    deadline: FAR_DEADLINE.toString(),
    signature,
  };
}

export async function signDeposit(
  account: Account,
  nonce: bigint,
  params: { asset: Address; amount: bigint },
) {
  const signature = await signTypedData({
    privateKey: account.privateKey,
    domain: EIP712_DOMAIN,
    types: EIP712_TYPES,
    primaryType: "Deposit",
    message: {
      asset: params.asset,
      amount: params.amount,
      nonce,
      deadline: FAR_DEADLINE,
    },
  });

  return {
    asset: params.asset,
    amount: params.amount.toString(),
    account: account.address,
    nonce: nonce.toString(),
    deadline: FAR_DEADLINE.toString(),
    signature,
  };
}
