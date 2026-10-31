import type { OrderBookManifest, OrderBookMutationName } from "order-book-sdk";
import {
  authorizeMutation,
  getAuthorizationPayload,
  packP256Signature,
  type TypedMutation,
} from "typewriter/client";
import { bytesToHex, type Hex, hexToBytes } from "viem";
import type { Account } from "./useStoredAccount";

async function signP256(keyPair: CryptoKeyPair, payload: Hex): Promise<Hex> {
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    keyPair.privateKey,
    hexToBytes(payload).buffer as ArrayBuffer,
  );
  return packP256Signature(bytesToHex(new Uint8Array(signature)));
}

export async function signMutation<const name extends OrderBookMutationName>(
  account: Account,
  manifest: OrderBookManifest,
  name: name,
  params: TypedMutation<OrderBookManifest, name>["params"],
) {
  const mutation = {
    name,
    params,
    accountID: account.accountId,
    // Sign-up adds the session key after the root credential.
    credentialID: 1n,
    nonce: account.nonce,
    expiration: 0n,
  };
  const signature = await signP256(
    account.keyPair,
    getAuthorizationPayload(manifest, mutation),
  );
  return authorizeMutation(mutation, signature);
}
