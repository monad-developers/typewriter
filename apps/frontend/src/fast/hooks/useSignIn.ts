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

      localStorage.setItem("address", address);
      localStorage.setItem("privateKey", privateKey);

      return account;
    },
  });
}
