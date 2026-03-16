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
      const res = await fetch("/sign-in", { method: "POST" });
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

      localStorage.setItem("address", address);
      localStorage.setItem("privateKey", privateKey);

      return account;
    },
  });
}
