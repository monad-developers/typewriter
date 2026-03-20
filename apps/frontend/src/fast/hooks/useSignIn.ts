import { useMutation } from "@tanstack/react-query";
import type { Address, Hex } from "viem";
import { useAccountContext } from "../contexts/AccountContext";

export function useSignIn() {
  const { setAccount } = useAccountContext();

  return useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/fast/sign-in", { method: "POST" });
      if (!res.ok) throw new Error("Sign-in failed");
      const { address, privateKey } = (await res.json()) as {
        address: Address;
        privateKey: Hex;
      };

      const account = { address, privateKey };
      setAccount(account);

      localStorage.setItem("fast:address", address);
      localStorage.setItem("fast:privateKey", privateKey);

      const bootId = document.cookie.match(/(?:^|; )fast-boot-id=([^;]*)/)?.[1];
      if (bootId) localStorage.setItem("fast:boot-id", bootId);

      return account;
    },
  });
}
