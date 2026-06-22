import { useMutation } from "@tanstack/react-query";
import { DEFAULT_NON_ROOT_PERMISSIONS } from "order-book-sdk";
import { bytesToHex, hashTypedData } from "viem";
import { Authentication as ClientAuthentication } from "webauthx/client";
import type { SubmittedOrderBookMutation } from "../../src/app";
import { useAccountContext } from "../contexts/AccountContext";
import { useDomainContext } from "../contexts/DomainContext";
import { request } from "../lib/api";
import { EIP712_TYPES, MAX_DEADLINE } from "../lib/eip712";
import { exportPublicKey, generateSessionKey } from "../lib/sessionKey";
import { encodeWebAuthnSignature, identify, RP_ID } from "../lib/webauthn";

export function useSignIn() {
  const { setAccount } = useAccountContext();
  const { domain } = useDomainContext();

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

      const nonce =
        BigInt(bytesToHex(crypto.getRandomValues(new Uint8Array(24)))) << 64n;

      const message = {
        account: accountId,
        expiry: 0,
        keyType: 0,
        permissions: DEFAULT_NON_ROOT_PERMISSIONS,
        publicKey: sessionPublicKey,
        nonce,
        deadline: MAX_DEADLINE,
      };

      const hash = hashTypedData({
        domain,
        types: { Authorize: EIP712_TYPES.Authorize },
        primaryType: "Authorize" as const,
        message,
      });

      const assertion = await ClientAuthentication.sign({
        rpId: RP_ID,
        challenge: hash,
      });

      const rawSignature = encodeWebAuthnSignature(assertion);

      await request("/api", {
        method: "POST",
        body: {
          name: "Authorize",
          params: message,
          signature: { account: accountId, keyId: 0n, rawSignature },
        } satisfies SubmittedOrderBookMutation<"Authorize">,
      });

      await setAccount({ accountId, keyId: keys.length, sessionKey });
    },
  });
}
