import { useMutation, useQueryClient } from "@tanstack/react-query";
import { SESSION_KEY_PERMISSIONS } from "pixel-war-sdk";
import { hexToBytes, keccak256 } from "viem";
import { Registration as ClientRegistration } from "webauthx/client";
import { Registration as ServerRegistration } from "webauthx/server";
import type { SubmittedPixelWarMutation } from "../../src/app";
import { useAccountContext } from "../contexts/AccountContext";
import { request } from "../lib/api";
import { exportPublicKey, generateSessionKey } from "../lib/sessionKey";
import { RP_ID, RP_NAME } from "../lib/webauthn";

/// Creates a passkey, derives the account id from its public key, and registers
/// both the passkey (root) and a fresh P-256 session key in one unsigned
/// bootstrap mutation. No wallet, no gas, no seed phrase.
export function useSignUp() {
  const { setAccount } = useAccountContext();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async () => {
      const sessionKey = await generateSessionKey();
      const sessionPublicKey = await exportPublicKey(sessionKey);

      const placeholderUserId = crypto.getRandomValues(new Uint8Array(32));
      const { options } = ServerRegistration.getOptions({
        name: RP_NAME,
        rp: { id: RP_ID, name: RP_NAME },
        user: {
          id: placeholderUserId,
          name: RP_NAME,
          displayName: RP_NAME,
        },
        authenticatorSelection: {
          userVerification: "discouraged",
          residentKey: "required",
          requireResidentKey: true,
        },
      });
      const credential = await ClientRegistration.create({ options });
      const accountId = keccak256(hexToBytes(credential.publicKey));

      await request("/api", {
        method: "POST",
        body: {
          name: "Initialize",
          params: {
            account: accountId,
            expiry: 0,
            rootKeyType: 1,
            keyType: 0,
            permissions: SESSION_KEY_PERMISSIONS,
            rootPublicKey: credential.publicKey,
            publicKey: sessionPublicKey,
          },
          signature: { account: accountId, keyId: 0n, rawSignature: "0x" },
        } satisfies SubmittedPixelWarMutation<"Initialize">,
      });

      await setAccount({ accountId, keyId: 1, sessionKey });
      await queryClient.invalidateQueries({ queryKey: ["accountState"] });
    },
  });
}
