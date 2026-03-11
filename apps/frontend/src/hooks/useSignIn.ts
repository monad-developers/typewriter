import { useMutation } from "@tanstack/react-query";
import { createWalletClient, http, parseEther } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { anvil } from "viem/chains";
import { useAccountContext } from "@/contexts/AccountContext";
import {
  type ANVIL_ACCOUNTS,
  RPC_URL,
  TOKEN_ABI,
  TOKEN_ADDRESS,
} from "../constants";
import { publicClient } from "../lib/client";

type AvailableAccount = (typeof ANVIL_ACCOUNTS)[number];

export function useSignIn() {
  const { setAccount } = useAccountContext();

  return useMutation({
    mutationFn: async (accounts: readonly AvailableAccount[]) => {
      const picked = accounts[Math.floor(Math.random() * accounts.length)]!;
      const walletClient = createWalletClient({
        account: privateKeyToAccount(picked.privateKey),
        transport: http(RPC_URL),
        chain: anvil,
      });

      const hash = await walletClient.writeContract({
        address: TOKEN_ADDRESS,
        abi: TOKEN_ABI,
        functionName: "mint",
        args: [picked.address, parseEther("100")],
      });

      await publicClient.waitForTransactionReceipt({ hash });

      localStorage.setItem("address", picked.address);
      localStorage.setItem("privateKey", picked.privateKey);

      const account = { ...picked, walletClient };
      setAccount(account);
      return account;
    },
    onSuccess: () => {},
  });
}
