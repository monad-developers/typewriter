import type { OrderBookManifest, OrderBookMutationName } from "order-book-sdk";
import type { TypedMutation } from "typewriter/client";
import { webCryptoSigner } from "../lib/signer";
import type { Account } from "./useStoredAccount";

export async function signMutation<const name extends OrderBookMutationName>(
  account: Account,
  manifest: OrderBookManifest,
  name: name,
  params: TypedMutation<OrderBookManifest, name>["params"],
) {
  const signer = await webCryptoSigner(manifest, account.keyPair);
  return signer.signMutation({
    name,
    params,
    accountID: account.accountId,
    // Sign-up adds the session key after the root credential.
    credentialID: 1n,
    nonce: account.nonce,
    expiration: 0,
  });
}
