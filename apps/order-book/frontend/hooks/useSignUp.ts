import { useMutation, useQueryClient } from "@tanstack/react-query";
import { DEFAULT_NON_ROOT_PERMISSIONS, randomNonce } from "order-book-sdk";
import { createAccountMutation } from "typewriter/client";
import { Registration as ClientRegistration } from "webauthx/client";
import { Registration as ServerRegistration } from "webauthx/server";
import { saveStoredAccount } from "../lib/account-store";
import { request } from "../lib/api";
import { passkeySigner, webCryptoSigner } from "../lib/signer";
import { RP_ID, RP_NAME } from "../lib/webauthn";
import { useManifest } from "./useManifest";
import { toAccount } from "./useStoredAccount";

export function useSignUp() {
  const { data: manifest } = useManifest();
  const storageKey = manifest?.deployment;
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async () => {
      const keyPair = await crypto.subtle.generateKey(
        { name: "ECDSA", namedCurve: "P-256" },
        false,
        ["sign", "verify"],
      );
      if (manifest === undefined || storageKey === undefined) {
        throw new Error("Missing manifest");
      }
      const session = await webCryptoSigner(manifest, keyPair);

      const placeholderUserId = crypto.getRandomValues(new Uint8Array(32));
      const { options: createOptions } = ServerRegistration.getOptions({
        name: RP_NAME,
        rp: { id: RP_ID, name: RP_NAME },
        user: { id: placeholderUserId, name: RP_NAME, displayName: RP_NAME },
        authenticatorSelection: {
          userVerification: "discouraged",
          residentKey: "required",
          requireResidentKey: true,
        },
      });
      const credential = await ClientRegistration.create({
        options: createOptions,
      });

      const passkey = passkeySigner(manifest, credential.publicKey, RP_ID);
      const createMutation = createAccountMutation(passkey);
      const accountId = createMutation.accountID;
      await request("/api", {
        method: "POST",
        body: await passkey.signMutation(createMutation),
      });

      await request("/api", {
        method: "POST",
        body: await passkey.signMutation({
          name: "AddCredential",
          params: {
            expiration: 0,
            keyType: session.keyType,
            permissions: DEFAULT_NON_ROOT_PERMISSIONS,
            publicKey: session.publicKey,
          },
          accountID: accountId,
          credentialID: 0n,
          nonce: randomNonce(),
          expiration: 0,
        }),
      });

      const stored = { accountId, keyPair };
      await saveStoredAccount(storageKey, stored);
      return toAccount(stored);
    },
    onSuccess: (account) => {
      queryClient.setQueryData(["storedAccount", storageKey], account);
    },
  });
}
