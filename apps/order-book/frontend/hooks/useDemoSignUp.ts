import { useMutation } from "@tanstack/react-query";
import { DEFAULT_NON_ROOT_PERMISSIONS } from "order-book-sdk";
import type { Hex } from "viem";
import { keccak256 } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { useAccountContext } from "../contexts/AccountContext";
import { MAX_DEADLINE } from "../lib/eip712";
import { exportPublicKey, generateSessionKey } from "../lib/sessionKey";

export function useDemoSignUp() {
  const { setAccount } = useAccountContext();

  return useMutation({
    mutationFn: async () => {
      const rootPrivateKey = generatePrivateKey();
      const rootWallet = privateKeyToAccount(rootPrivateKey);
      const rootPublicKey =
        `0x000000000000000000000000${rootWallet.address.slice(2).toLowerCase()}` as Hex;
      const accountId = keccak256(rootPublicKey);

      const sessionKey = await generateSessionKey();
      const sessionPublicKey = await exportPublicKey(sessionKey);

      const initRes = await fetch("/api/initialize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          account: accountId,
          expiry: 0,
          rootKeyType: 2,
          keyType: 0,
          permissions: DEFAULT_NON_ROOT_PERMISSIONS,
          rootPublicKey,
          publicKey: sessionPublicKey,
          keyId: 0,
          nonce: "0",
          deadline: MAX_DEADLINE.toString(),
          rawSignature: "0x",
        }),
      });
      if (!initRes.ok) {
        const body = await initRes.json();
        throw new Error(body.error ?? "Initialize failed");
      }

      const nonceKey = BigInt(keccak256(sessionPublicKey)) >> 64n;
      await setAccount({ accountId, keyId: 1, nonceKey, sessionKey });
    },
  });
}
