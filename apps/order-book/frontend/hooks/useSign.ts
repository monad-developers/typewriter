import type { TypewriterManifest } from "typewriter";
import {
  authorizeMutation,
  getAuthorizationPayload,
  packP256Signature,
  type TypedMutation,
} from "typewriter/client";
import { type Address, bytesToHex, type Hex, hexToBytes } from "viem";
import type { SubmittedOrderBookMutation } from "../../src/app";
import type { Account } from "./useStoredAccount";

async function signP256(keyPair: CryptoKeyPair, payload: Hex): Promise<Hex> {
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    keyPair.privateKey,
    hexToBytes(payload).buffer as ArrayBuffer,
  );
  return packP256Signature(bytesToHex(new Uint8Array(signature)));
}

async function signMutation<const name extends string>(params: {
  account: Account;
  manifest: TypewriterManifest;
  name: name;
  nonce: bigint;
  mutationParams: Record<string, unknown>;
}): Promise<SubmittedOrderBookMutation<name>> {
  const mutation = {
    name: params.name,
    params: params.mutationParams,
    accountID: params.account.accountId,
    // Sign-up adds the session key after the root credential.
    credentialID: 1n,
    nonce: params.nonce,
    expiration: 0n,
  } as unknown as TypedMutation<TypewriterManifest, name>;
  const signature = await signP256(
    params.account.keyPair,
    getAuthorizationPayload(params.manifest, mutation),
  );
  return authorizeMutation(
    mutation,
    signature,
  ) as SubmittedOrderBookMutation<name>;
}

export function signMarketOrder(
  account: Account,
  manifest: TypewriterManifest,
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
    manifest,
    name: "MarketOrder",
    nonce,
    mutationParams: { ...params, instrumentId: BigInt(params.instrumentId) },
  });
}

export function signLimitOrder(
  account: Account,
  manifest: TypewriterManifest,
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
    manifest,
    name: "LimitOrder",
    nonce,
    mutationParams: { ...params, instrumentId: BigInt(params.instrumentId) },
  });
}

export function signCloseOrder(
  account: Account,
  manifest: TypewriterManifest,
  nonce: bigint,
  params: { orderId: number },
) {
  return signMutation({
    account,
    manifest,
    name: "CloseOrder",
    nonce,
    mutationParams: { orderId: BigInt(params.orderId) },
  });
}

export function signDeposit(
  account: Account,
  manifest: TypewriterManifest,
  nonce: bigint,
  params: { asset: Address; amount: bigint },
) {
  return signMutation({
    account,
    manifest,
    name: "Deposit",
    nonce,
    mutationParams: params,
  });
}
