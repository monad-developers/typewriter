import { useMutation, useQueryClient } from "@tanstack/react-query";
import { DEFAULT_NON_ROOT_PERMISSIONS } from "order-book-sdk";
import {
  authorizeMutation,
  deploymentKey,
  deriveAccountID,
  getAuthorizationPayload,
  type TypedMutation,
} from "typewriter/client";
import { bytesToHex } from "viem";
import {
  Authentication as ClientAuthentication,
  Registration as ClientRegistration,
} from "webauthx/client";
import { Registration as ServerRegistration } from "webauthx/server";
import { saveStoredAccount } from "../lib/account-store";
import { request } from "../lib/api";
import { encodeWebAuthnSignature, RP_ID, RP_NAME } from "../lib/webauthn";
import { useManifest } from "./useManifest";
import { toAccount } from "./useStoredAccount";

export function useSignUp() {
  const { data: manifest } = useManifest();
  const storageKey =
    manifest === undefined
      ? undefined
      : deploymentKey(manifest.chainId, manifest.address);
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async () => {
      const keyPair = await crypto.subtle.generateKey(
        { name: "ECDSA", namedCurve: "P-256" },
        false,
        ["sign", "verify"],
      );
      const sessionPublicKey = bytesToHex(
        new Uint8Array(await crypto.subtle.exportKey("raw", keyPair.publicKey)),
      );
      if (manifest === undefined || storageKey === undefined) {
        throw new Error("Missing manifest");
      }

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

      const createParams = {
        keyType: 1,
        publicKey: credential.publicKey,
      } as const;
      const accountId = deriveAccountID(createParams);
      const createMutation = {
        name: "CreateAccount",
        params: createParams,
        accountID: accountId,
        credentialID: 0n,
        nonce: 0n,
        expiration: 0n,
      } as unknown as TypedMutation<typeof manifest, "CreateAccount">;
      const createAssertion = await ClientAuthentication.sign({
        rpId: RP_ID,
        challenge: getAuthorizationPayload(manifest, createMutation),
      });

      await request("/api", {
        method: "POST",
        body: authorizeMutation(
          createMutation,
          encodeWebAuthnSignature(createAssertion),
        ),
      });

      const addMutation = {
        name: "AddCredential",
        params: {
          expiration: 0n,
          keyType: 0,
          permissions: BigInt(DEFAULT_NON_ROOT_PERMISSIONS),
          publicKey: sessionPublicKey,
        },
        accountID: accountId,
        credentialID: 0n,
        nonce:
          BigInt(bytesToHex(crypto.getRandomValues(new Uint8Array(24)))) << 64n,
        expiration: 0n,
      } as unknown as TypedMutation<typeof manifest, "AddCredential">;
      const addAssertion = await ClientAuthentication.sign({
        rpId: RP_ID,
        challenge: getAuthorizationPayload(manifest, addMutation),
      });
      await request("/api", {
        method: "POST",
        body: authorizeMutation(
          addMutation,
          encodeWebAuthnSignature(addAssertion),
        ),
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
