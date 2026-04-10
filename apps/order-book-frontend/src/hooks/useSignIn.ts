import { useMutation } from "@tanstack/react-query";
import { bytesToHex, hashTypedData, keccak256 } from "viem";
import { Authentication as ClientAuthentication } from "webauthx/client";
import { useAccountContext } from "../contexts/AccountContext";
import { EIP712_DOMAIN, EIP712_TYPES, MAX_DEADLINE } from "../lib/eip712";
import { exportPublicKey, generateSessionKey } from "../lib/sessionKey";
import { encodeWebAuthnSignature, identify, RP_ID } from "../lib/webauthn";

export function useSignIn() {
  const { setAccount } = useAccountContext();

  return useMutation({
    mutationFn: async () => {
      const [accountId, sessionKey] = await Promise.all([
        identify(),
        generateSessionKey(),
      ]);
      const sessionPublicKey = await exportPublicKey(sessionKey);

      const nonce =
        BigInt(bytesToHex(crypto.getRandomValues(new Uint8Array(24)))) << 64n;

      const message = {
        account: accountId,
        expiry: 0,
        keyType: 0,
        permissions: 0xff,
        publicKey: sessionPublicKey,
        nonce,
        deadline: MAX_DEADLINE,
      };

      const hash = hashTypedData({
        domain: EIP712_DOMAIN,
        types: { Authorize: EIP712_TYPES.Authorize },
        primaryType: "Authorize" as const,
        message,
      });

      const assertion = await ClientAuthentication.sign({
        rpId: RP_ID,
        challenge: hash,
      });

      const rawSignature = encodeWebAuthnSignature(assertion);

      const res = await fetch("/api/authorize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...message,
          nonce: nonce.toString(),
          deadline: MAX_DEADLINE.toString(),
          keyId: 0,
          rawSignature,
        }),
      });

      if (!res.ok) {
        const body = await res.json();
        throw new Error(body.error ?? "Authorize failed");
      }

      const nonceKey = BigInt(keccak256(sessionPublicKey)) >> 64n;
      await setAccount({ accountId, keyId: 1, nonceKey, sessionKey });
    },
  });
}
