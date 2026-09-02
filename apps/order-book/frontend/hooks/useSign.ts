import {
  authorizeMutation,
  getAuthorizationPayload,
  packP256Signature,
  type TypedMutation,
} from "typewriter/client";
import { type Address, bytesToHex, type Hex, hexToBytes } from "viem";
import type { SubmittedOrderBookMutation } from "../../src/app";
import type { Account } from "../contexts/AccountContext";
import type { AppDomain } from "../lib/domain";

async function signP256(sessionKey: CryptoKeyPair, payload: Hex): Promise<Hex> {
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    sessionKey.privateKey,
    hexToBytes(payload).buffer as ArrayBuffer,
  );
  return packP256Signature(bytesToHex(new Uint8Array(signature)));
}

async function signMutation<const name extends string>(params: {
  account: Account;
  domain: AppDomain;
  name: name;
  nonce: bigint;
  mutationParams: Record<string, unknown>;
}): Promise<SubmittedOrderBookMutation<name>> {
  const mutation = {
    name: params.name,
    params: params.mutationParams,
    accountID: params.account.accountId,
    credentialID: BigInt(params.account.keyId),
    nonce: params.nonce,
    expiration: 0n,
  } as unknown as TypedMutation<AppDomain, name>;
  const signature = await signP256(
    params.account.sessionKey,
    getAuthorizationPayload(params.domain, mutation),
  );
  return authorizeMutation(
    mutation,
    signature,
  ) as SubmittedOrderBookMutation<name>;
}

export function signMarketOrder(
  account: Account,
  domain: AppDomain,
  nonce: bigint,
  params: {
    quantity: bigint;
    minReceivedQuantity: bigint;
    instrumentId: number;
    bidOrAsk: 0 | 1;
  },
) {
  return signMutation({
    account,
    domain,
    name: "MarketOrder",
    nonce,
    mutationParams: { ...params, instrumentId: BigInt(params.instrumentId) },
  });
}

export function signLimitOrder(
  account: Account,
  domain: AppDomain,
  nonce: bigint,
  params: {
    quantity: bigint;
    instrumentId: number;
    price: bigint;
    bidOrAsk: 0 | 1;
  },
) {
  return signMutation({
    account,
    domain,
    name: "LimitOrder",
    nonce,
    mutationParams: { ...params, instrumentId: BigInt(params.instrumentId) },
  });
}

export function signCloseOrder(
  account: Account,
  domain: AppDomain,
  nonce: bigint,
  params: { orderId: number },
) {
  return signMutation({
    account,
    domain,
    name: "CloseOrder",
    nonce,
    mutationParams: { orderId: BigInt(params.orderId) },
  });
}

export function signDeposit(
  account: Account,
  domain: AppDomain,
  nonce: bigint,
  params: { asset: Address; amount: bigint },
) {
  return signMutation({
    account,
    domain,
    name: "Deposit",
    nonce,
    mutationParams: params,
  });
}
