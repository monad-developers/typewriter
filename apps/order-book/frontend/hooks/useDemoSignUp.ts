import { useMutation } from "@tanstack/react-query";
import { DEFAULT_NON_ROOT_PERMISSIONS } from "order-book-sdk";
import type { Hex } from "viem";
import { keccak256 } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import type { SubmittedOrderBookMutation } from "../../src/app";
import { useAccountContext } from "../contexts/AccountContext";
import { request } from "../lib/api";
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

      await request("/api", {
        method: "POST",
        body: {
          name: "Initialize",
          params: {
            account: accountId,
            expiry: 0,
            rootKeyType: 2,
            keyType: 0,
            permissions: DEFAULT_NON_ROOT_PERMISSIONS,
            rootPublicKey,
            publicKey: sessionPublicKey,
          },
          signature: {
            account: accountId,
            keyId: 0n,
            rawSignature: "0x",
          },
        } satisfies Extract<SubmittedOrderBookMutation, { name: "Initialize" }>,
      });

      await setAccount({ accountId, keyId: 1, sessionKey });
    },
  });
}
