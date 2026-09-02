import { useMutation } from "@tanstack/react-query";
import { DEFAULT_NON_ROOT_PERMISSIONS } from "order-book-sdk";
import {
  authorizeMutation,
  getAuthorizationPayload,
  type TypedMutation,
} from "typewriter/client";
import { bytesToHex } from "viem";
import { Authentication as ClientAuthentication } from "webauthx/client";
import { useAccountContext } from "../contexts/AccountContext";
import { useManifestContext } from "../contexts/ManifestContext";
import { request } from "../lib/api";
import { exportPublicKey, generateSessionKey } from "../lib/sessionKey";
import { encodeWebAuthnSignature, identify, RP_ID } from "../lib/webauthn";

export function useSignIn() {
  const { setAccount } = useAccountContext();
  const { manifest } = useManifestContext();

  return useMutation({
    mutationFn: async () => {
      if (manifest === null) throw new Error("Missing manifest");
      const [accountId, sessionKey] = await Promise.all([
        identify(),
        generateSessionKey(),
      ]);
      const sessionPublicKey = await exportPublicKey(sessionKey);
      const account = await request<{
        credentials: { keyType: number }[];
      }>(`/api/account/${accountId}`);
      if (account.credentials.length === 0) {
        throw new Error("Account has no credentials");
      }

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
      const assertion = await ClientAuthentication.sign({
        rpId: RP_ID,
        challenge: getAuthorizationPayload(manifest, addMutation),
      });

      await request("/api", {
        method: "POST",
        body: authorizeMutation(
          addMutation,
          encodeWebAuthnSignature(assertion),
        ),
      });

      await setAccount({
        accountId,
        keyId: account.credentials.length,
        sessionKey,
      });
    },
  });
}
