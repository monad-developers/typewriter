import { useMutation } from "@tanstack/react-query";
import { DEFAULT_NON_ROOT_PERMISSIONS } from "order-book-sdk";
import { hexToBytes, keccak256 } from "viem";
import { Registration as ClientRegistration } from "webauthx/client";
import { Registration as ServerRegistration } from "webauthx/server";
import { useAccountContext } from "../contexts/AccountContext";
import { MAX_DEADLINE } from "../lib/eip712";
import { exportPublicKey, generateSessionKey } from "../lib/sessionKey";
import { RP_ID, RP_NAME } from "../lib/webauthn";

export function useSignUp() {
  const { setAccount } = useAccountContext();

  return useMutation({
    mutationFn: async () => {
      const sessionKey = await generateSessionKey();
      const sessionPublicKey = await exportPublicKey(sessionKey);

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

      const accountId = keccak256(hexToBytes(credential.publicKey));

      const res = await fetch("/api/initialize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          account: accountId,
          expiry: 0,
          rootKeyType: 1,
          keyType: 0,
          permissions: DEFAULT_NON_ROOT_PERMISSIONS,
          rootPublicKey: credential.publicKey,
          publicKey: sessionPublicKey,
          keyId: 0,
          nonce: "0",
          deadline: MAX_DEADLINE.toString(),
          rawSignature: "0x",
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
