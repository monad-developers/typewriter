import { useMutation } from "@tanstack/react-query";
import type { Address, Hex } from "viem";
import { createWalletClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { useAccountContext } from "@/contexts/AccountContext";
import { CHAIN, RPC_URL } from "../constants";
import { loggingTransport } from "../lib/loggingTransport";

export function useSignIn() {
  const { setAccount } = useAccountContext();

  return useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/sign-in", { method: "POST" });
      if (!res.ok) throw new Error("Sign-in failed");
      const { address, privateKey } = (await res.json()) as {
        address: Address;
        privateKey: Hex;
      };

      const walletClient = createWalletClient({
        account: privateKeyToAccount(privateKey),
        transport: loggingTransport(RPC_URL),
        chain: CHAIN,
      });

      const account = { address, privateKey, walletClient };
      setAccount(account);

      localStorage.setItem("normal:address", address);
      localStorage.setItem("normal:privateKey", privateKey);

      const bootId = document.cookie.match(/(?:^|; )boot-id=([^;]*)/)?.[1];
      if (bootId) localStorage.setItem("normal:boot-id", bootId);

      return account;
    },
  });
}
