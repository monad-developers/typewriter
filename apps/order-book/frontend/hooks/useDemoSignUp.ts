import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  authorizeWithSecp256k1,
  createSecp256k1Account,
  DEFAULT_NON_ROOT_PERMISSIONS,
  randomNonce,
} from "order-book-sdk";
import { Secp256k1 } from "ox";
import { KeyType } from "typewriter/client";
import { bytesToHex } from "viem";
import { saveStoredAccount } from "../lib/account-store";
import { request } from "../lib/api";
import { useManifest } from "./useManifest";
import { toAccount } from "./useStoredAccount";

export function useDemoSignUp() {
  const { data: manifest } = useManifest();
  const storageKey = manifest?.deploymentKey;
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async () => {
      if (manifest === undefined || storageKey === undefined) {
        throw new Error("Missing manifest");
      }
      const rootPrivateKey = Secp256k1.randomPrivateKey();
      const { accountID, mutation } = createSecp256k1Account(
        manifest,
        rootPrivateKey,
      );
      await request("/api", { method: "POST", body: mutation });

      const keyPair = await crypto.subtle.generateKey(
        { name: "ECDSA", namedCurve: "P-256" },
        false,
        ["sign", "verify"],
      );
      const sessionPublicKey = bytesToHex(
        new Uint8Array(await crypto.subtle.exportKey("raw", keyPair.publicKey)),
      );
      const add = authorizeWithSecp256k1(manifest, rootPrivateKey, {
        name: "AddCredential",
        params: {
          expiration: 0n,
          keyType: KeyType.P256,
          permissions: BigInt(DEFAULT_NON_ROOT_PERMISSIONS),
          publicKey: sessionPublicKey,
        },
        accountID,
        credentialID: 0n,
        nonce: randomNonce(),
        expiration: 0n,
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
