import {
  type Address,
  bytesToHex,
  encodeAbiParameters,
  type Hex,
  hashTypedData,
  hexToBytes,
} from "viem";
import type { Account } from "../contexts/AccountContext";
import { EIP712_DOMAIN, EIP712_TYPES, MAX_DEADLINE } from "../lib/eip712";

async function signP256(sessionKey: CryptoKeyPair, hash: Hex): Promise<Hex> {
  const sig = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    sessionKey.privateKey,
    hexToBytes(hash).buffer as ArrayBuffer,
  );
  const bytes = new Uint8Array(sig);
  const r = BigInt(bytesToHex(bytes.slice(0, 32)));
  const s = BigInt(bytesToHex(bytes.slice(32)));
  return encodeAbiParameters(
    [{ type: "uint256" }, { type: "uint256" }],
    [r, s],
  );
}

export async function signMarketOrder(
  account: Account,
  nonce: bigint,
  params: {
    quantity: bigint;
    minReceivedQuantity: bigint;
    instrumentId: number;
    bidOrAsk: 0 | 1;
  },
) {
  const hash = hashTypedData({
    domain: EIP712_DOMAIN,
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
    ...params,
    quantity: params.quantity.toString(),
    minReceivedQuantity: params.minReceivedQuantity.toString(),
    account: account.accountId,
    keyId: account.keyId,
    nonce: nonce.toString(),
    deadline: MAX_DEADLINE.toString(),
    rawSignature,
  };
}

export async function signLimitOrder(
  account: Account,
  nonce: bigint,
  params: {
    quantity: bigint;
    instrumentId: number;
    price: bigint;
    bidOrAsk: 0 | 1;
  },
) {
  const hash = hashTypedData({
    domain: EIP712_DOMAIN,
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
    ...params,
    quantity: params.quantity.toString(),
    instrumentId: params.instrumentId,
    price: params.price.toString(),
    account: account.accountId,
    keyId: account.keyId,
    nonce: nonce.toString(),
    deadline: MAX_DEADLINE.toString(),
    rawSignature,
  };
}

export async function signCloseOrder(
  account: Account,
  nonce: bigint,
  params: { orderId: number },
) {
  const hash = hashTypedData({
    domain: EIP712_DOMAIN,
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
    ...params,
    account: account.accountId,
    keyId: account.keyId,
    nonce: nonce.toString(),
    deadline: MAX_DEADLINE.toString(),
    rawSignature,
  };
}

export async function signDeposit(
  account: Account,
  nonce: bigint,
  params: { asset: Address; amount: bigint },
) {
  const hash = hashTypedData({
    domain: EIP712_DOMAIN,
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
    asset: params.asset,
    amount: params.amount.toString(),
    account: account.accountId,
    keyId: account.keyId,
    nonce: nonce.toString(),
    deadline: MAX_DEADLINE.toString(),
    rawSignature,
  };
}
