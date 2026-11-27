import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  DEFAULT_NON_ROOT_PERMISSIONS,
  randomNonce,
  secp256k1Signer,
} from "order-book-sdk";
import { Secp256k1 } from "ox";
import { createAccountMutation } from "typewriter/client";
import { saveStoredAccount } from "../lib/account-store";
import { request } from "../lib/api";
import { webCryptoSigner } from "../lib/signer";
import { useManifest } from "./useManifest";
import { toAccount } from "./useStoredAccount";

export function useDemoSignUp() {
  const { data: manifest } = useManifest();
  const storageKey = manifest?.deployment;
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async () => {
      if (manifest === undefined || storageKey === undefined) {
        throw new Error("Missing manifest");
      }
      const root = secp256k1Signer(manifest, Secp256k1.randomPrivateKey());
      const create = createAccountMutation(root);
      const { accountID } = create;
      await request("/api", {
        method: "POST",
        body: await root.signMutation(create),
      });

      const keyPair = await crypto.subtle.generateKey(
        { name: "ECDSA", namedCurve: "P-256" },
        false,
        ["sign", "verify"],
      );
      const session = await webCryptoSigner(manifest, keyPair);
      const add = await root.signMutation({
        name: "AddCredential",
        params: {
          expiration: 0,
          keyType: session.keyType,
          permissions: DEFAULT_NON_ROOT_PERMISSIONS,
          publicKey: session.publicKey,
        },
        accountID,
        credentialID: 0n,
        nonce: randomNonce(),
        expiration: 0,
      });
      await request("/api", { method: "POST", body: add });
      const stored = { accountId: accountID, keyPair };
      await saveStoredAccount(storageKey, stored);
      return toAccount(stored);
    },
    onSuccess: (account) => {
      queryClient.setQueryData(["storedAccount", storageKey], account);
    },
  });
}
