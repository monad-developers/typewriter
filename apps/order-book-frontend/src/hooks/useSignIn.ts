import { useMutation } from "@tanstack/react-query";
import type { Address, Hex } from "viem";
import { useAccountContext } from "../contexts/AccountContext";

const STORAGE_PREFIX = "ob:";

export function useSignIn() {
  const { setAccount } = useAccountContext();

  return useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/add-account", { method: "POST" });
      if (!res.ok) throw new Error("Account creation failed");
      const { address, privateKey, bootId, accountId } = (await res.json()) as {
        address: Address;
        privateKey: Hex;
        bootId: string;
        accountId: number;
      };

      const account = { address, privateKey, accountId };
      setAccount(account);

      localStorage.setItem(`${STORAGE_PREFIX}address`, address);
      localStorage.setItem(`${STORAGE_PREFIX}privateKey`, privateKey);
      localStorage.setItem(`${STORAGE_PREFIX}accountId`, String(accountId));
      localStorage.setItem(`${STORAGE_PREFIX}boot-id`, bootId);

      return account;
    },
  });
}
