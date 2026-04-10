import { useMutation } from "@tanstack/react-query";
import { bytesToHex, hashTypedData, keccak256 } from "viem";
import {
  Authentication as ClientAuthentication,
  Registration as ClientRegistration,
} from "webauthx/client";
import { Registration as ServerRegistration } from "webauthx/server";
import { useAccountContext } from "../contexts/AccountContext";
import { EIP712_DOMAIN, EIP712_TYPES, MAX_DEADLINE } from "../lib/eip712";
import { exportPublicKey, generateSessionKey } from "../lib/sessionKey";
import { encodeWebAuthnSignature, RP_ID, RP_NAME } from "../lib/webauthn";

export function useSignUp() {
  const { setAccount } = useAccountContext();

  return useMutation({
    mutationFn: async () => {
      const accountIdBytes = crypto.getRandomValues(new Uint8Array(32));
      const accountId = bytesToHex(accountIdBytes);

      const sessionKey = await generateSessionKey();
      const sessionPublicKey = await exportPublicKey(sessionKey);

      const { options: createOptions } = ServerRegistration.getOptions({
        name: RP_NAME,
        rp: { id: RP_ID, name: RP_NAME },
        user: { id: accountIdBytes, name: RP_NAME, displayName: RP_NAME },
      });
      const credential = await ClientRegistration.create({
        options: createOptions,
      });

      const message = {
        account: accountId,
        expiry: 0,
        rootKeyType: 1,
        keyType: 0,
        permissions: 0xff,
        rootPublicKey: credential.publicKey,
        publicKey: sessionPublicKey,
      };

      const hash = hashTypedData({
        domain: EIP712_DOMAIN,
        types: { Initialize: EIP712_TYPES.Initialize },
        primaryType: "Initialize" as const,
        message,
      });

      const assertion = await ClientAuthentication.sign({
        rpId: RP_ID,
        challenge: hash,
      });

      const rawSignature = encodeWebAuthnSignature(assertion);

      const res = await fetch("/api/initialize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...message,
          keyId: 0,
          nonce: "0",
          deadline: MAX_DEADLINE.toString(),
          rawSignature,
        }),
      });

      if (!res.ok) {
        const body = await res.json();
        throw new Error(body.error ?? "Initialize failed");
      }

      const nonceKey = BigInt(keccak256(sessionPublicKey)) >> 64n;
      await setAccount({ accountId, keyId: 1, nonceKey, sessionKey });
    },
  });
}
