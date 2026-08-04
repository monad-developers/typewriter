import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  EIP712_TYPES,
  MAX_DEADLINE,
  SESSION_KEY_PERMISSIONS,
} from "pixel-war-sdk";
import { bytesToHex, hashTypedData } from "viem";
import { Authentication as ClientAuthentication } from "webauthx/client";
import type { SubmittedPixelWarMutation } from "../../src/app";
import { useAccountContext } from "../contexts/AccountContext";
import { useDomainContext } from "../contexts/DomainContext";
import { request } from "../lib/api";
import { exportPublicKey, generateSessionKey } from "../lib/sessionKey";
import { encodeWebAuthnSignature, identify, RP_ID } from "../lib/webauthn";

/// Signing in on a new device authorizes a new session key with the passkey. The
/// passkey signature is verified onchain by the WebAuthn-P256 path.
export function useSignIn() {
  const { setAccount } = useAccountContext();
  const { domain } = useDomainContext();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async () => {
      if (domain === null) throw new Error("Missing domain");

      const [accountId, sessionKey] = await Promise.all([
        identify(),
        generateSessionKey(),
      ]);
      const sessionPublicKey = await exportPublicKey(sessionKey);
      const { keys } = await request<{ keys: unknown[] }>(
        `/api/account/${accountId}`,
      );

      const message = {
        account: accountId,
        expiry: 0,
        keyType: 0,
        permissions: SESSION_KEY_PERMISSIONS,
        publicKey: sessionPublicKey,
        nonce:
          BigInt(bytesToHex(crypto.getRandomValues(new Uint8Array(24)))) << 64n,
        deadline: MAX_DEADLINE,
      };

      const assertion = await ClientAuthentication.sign({
        rpId: RP_ID,
        challenge: hashTypedData({
          domain,
          types: { Authorize: EIP712_TYPES.Authorize },
          primaryType: "Authorize" as const,
          message,
        }),
      });

      await request("/api", {
        method: "POST",
        body: {
          name: "Authorize",
          params: message,
          signature: {
            account: accountId,
            keyId: 0n,
            rawSignature: encodeWebAuthnSignature(assertion),
          },
        } satisfies SubmittedPixelWarMutation<"Authorize">,
      });

      await setAccount({ accountId, keyId: keys.length, sessionKey });
      await queryClient.invalidateQueries({ queryKey: ["accountState"] });
    },
  });
}
