import { useMutation } from "@tanstack/react-query";
import type { Hex } from "viem";
import { keccak256 } from "viem";
import {
  generatePrivateKey,
  privateKeyToAccount,
  signTypedData,
} from "viem/accounts";
import { useAccountContext } from "../contexts/AccountContext";
import { EIP712_DOMAIN, EIP712_TYPES, MAX_DEADLINE } from "../lib/eip712";
import { exportPublicKey, generateSessionKey } from "../lib/sessionKey";

export function useDemoSignUp() {
  const { setAccount } = useAccountContext();

  return useMutation({
    mutationFn: async () => {
      const rootPrivateKey = generatePrivateKey();
      const rootWallet = privateKeyToAccount(rootPrivateKey);
      const accountId =
        `0x000000000000000000000000${rootWallet.address.slice(2).toLowerCase()}` as Hex;

      const sessionKey = await generateSessionKey();
      const sessionPublicKey = await exportPublicKey(sessionKey);

      const initSignature = await signTypedData({
        privateKey: rootPrivateKey,
        domain: EIP712_DOMAIN,
        types: { Initialize: EIP712_TYPES.Initialize },
        primaryType: "Initialize",
        message: {
          account: accountId,
          expiry: 0,
          rootKeyType: 2,
          keyType: 0,
          permissions: 0xff,
          rootPublicKey: accountId,
          publicKey: sessionPublicKey,
        },
      });

      const initRes = await fetch("/api/initialize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          account: accountId,
          expiry: 0,
          rootKeyType: 2,
          keyType: 0,
          permissions: 0xff,
          rootPublicKey: accountId,
          publicKey: sessionPublicKey,
          keyId: 0,
          nonce: "0",
          deadline: MAX_DEADLINE.toString(),
          rawSignature: initSignature,
        }),
      });
      if (!initRes.ok) {
        const body = await initRes.json();
        throw new Error(body.error?.split(":")[0] ?? "Initialize failed");
      }

      const nonceKey = BigInt(keccak256(sessionPublicKey)) >> 64n;
      await setAccount({ accountId, keyId: 1, nonceKey, sessionKey });
    },
  });
}
