import {
  type Address,
  bytesToHex,
  encodeAbiParameters,
  type Hex,
  hashTypedData,
  hexToBytes,
} from "viem";
import type { SubmittedOrderBookMutation } from "../../src/app";
import type { Account } from "../contexts/AccountContext";
import type { AppDomain } from "../lib/domain";
import { EIP712_TYPES, MAX_DEADLINE } from "../lib/eip712";

const P256_N =
  0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;

type SignedMutation<name extends string> = SubmittedOrderBookMutation<name>;

async function signP256(sessionKey: CryptoKeyPair, hash: Hex): Promise<Hex> {
  const sig = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    sessionKey.privateKey,
    hexToBytes(hash).buffer as ArrayBuffer,
  );
  const bytes = new Uint8Array(sig);
  const r = BigInt(bytesToHex(bytes.slice(0, 32)));
  let s = BigInt(bytesToHex(bytes.slice(32)));
  if (s > P256_N / 2n) s = P256_N - s;
  return encodeAbiParameters(
    [{ type: "uint256" }, { type: "uint256" }],
    [r, s],
  );
}

export async function signMarketOrder(
  account: Account,
  domain: AppDomain,
  nonce: bigint,
  params: {
    quantity: bigint;
    minReceivedQuantity: bigint;
    instrumentId: number;
    bidOrAsk: 0 | 1;
  },
): Promise<SignedMutation<"MarketOrder">> {
  const hash = hashTypedData({
    domain,
    types: { MarketOrder: EIP712_TYPES.MarketOrder },
    primaryType: "MarketOrder",
    message: {
      quantity: params.quantity,
      minReceivedQuantity: params.minReceivedQuantity,
      instrumentId: BigInt(params.instrumentId),
      bidOrAsk: params.bidOrAsk,
      nonce,
      deadline: MAX_DEADLINE,
    },
  });

  const rawSignature = await signP256(account.sessionKey, hash);

  return {
    name: "MarketOrder",
    params: {
      ...params,
      instrumentId: BigInt(params.instrumentId),
      nonce,
      deadline: MAX_DEADLINE,
    },
    signature: {
      account: account.accountId,
      keyId: BigInt(account.keyId),
      rawSignature,
    },
  };
}

export async function signLimitOrder(
  account: Account,
  domain: AppDomain,
  nonce: bigint,
  params: {
    quantity: bigint;
    instrumentId: number;
    price: bigint;
    bidOrAsk: 0 | 1;
  },
): Promise<SignedMutation<"LimitOrder">> {
  const hash = hashTypedData({
    domain,
    types: { LimitOrder: EIP712_TYPES.LimitOrder },
    primaryType: "LimitOrder",
    message: {
      quantity: params.quantity,
      instrumentId: BigInt(params.instrumentId),
      price: params.price,
      bidOrAsk: params.bidOrAsk,
      nonce,
      deadline: MAX_DEADLINE,
    },
  });

  const rawSignature = await signP256(account.sessionKey, hash);

  return {
    name: "LimitOrder",
    params: {
      ...params,
      instrumentId: BigInt(params.instrumentId),
      nonce,
      deadline: MAX_DEADLINE,
    },
    signature: {
      account: account.accountId,
      keyId: BigInt(account.keyId),
      rawSignature,
    },
  };
}

export async function signCloseOrder(
  account: Account,
  domain: AppDomain,
  nonce: bigint,
  params: { orderId: number },
): Promise<SignedMutation<"CloseOrder">> {
  const hash = hashTypedData({
    domain,
    types: { CloseOrder: EIP712_TYPES.CloseOrder },
    primaryType: "CloseOrder",
    message: {
      orderId: BigInt(params.orderId),
      nonce,
      deadline: MAX_DEADLINE,
    },
  });

  const rawSignature = await signP256(account.sessionKey, hash);

  return {
    name: "CloseOrder",
    params: {
      orderId: BigInt(params.orderId),
      nonce,
      deadline: MAX_DEADLINE,
    },
    signature: {
      account: account.accountId,
      keyId: BigInt(account.keyId),
      rawSignature,
    },
  };
}

export async function signDeposit(
  account: Account,
  domain: AppDomain,
  nonce: bigint,
  params: { asset: Address; amount: bigint },
): Promise<SignedMutation<"Deposit">> {
  const hash = hashTypedData({
    domain,
    types: { Deposit: EIP712_TYPES.Deposit },
    primaryType: "Deposit",
    message: {
      asset: params.asset,
      amount: params.amount,
      nonce,
      deadline: MAX_DEADLINE,
    },
  });

  const rawSignature = await signP256(account.sessionKey, hash);

  return {
    name: "Deposit",
    params: {
      asset: params.asset,
      amount: params.amount,
      nonce,
      deadline: MAX_DEADLINE,
    },
    signature: {
      account: account.accountId,
      keyId: BigInt(account.keyId),
      rawSignature,
    },
  };
}
