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
  const { setAccount, addTx, updateTx } = useAccountContext();

  return useMutation({
    mutationFn: async (accounts: readonly AvailableAccount[]) => {
      const picked = accounts[Math.floor(Math.random() * accounts.length)]!;
      const walletClient = createWalletClient({
        account: privateKeyToAccount(picked.privateKey),
        transport: http(RPC_URL),
        chain: anvil,
      });

      const account = { ...picked, walletClient };
      setAccount(account);

      let start = performance.now();

      // TODO(kyle) eth_sendRawTransactionSync
      const hash = await walletClient.writeContract({
        address: TOKEN_ADDRESS,
        abi: TOKEN_ABI,
        functionName: "mint",
        args: [picked.address, parseEther("100")],
      });

      const preflightLatency = performance.now() - start;
      start = performance.now();

      addTx(
        {
          hash,
          status: "pending",
          amount: parseEther("100"),
          to: picked.address,
          cost: null,
          preflightLatency,
          submissionLatency: null,
          timestamp: Date.now(),
        },
        picked.address,
      );

      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      const submissionLatency = performance.now() - start;

      updateTx(
        hash,
        {
          status: "proposed",
          submissionLatency,
          cost: receipt.gasUsed * 102n * 10n ** 9n,
        },
        picked.address,
      );

      localStorage.setItem("address", picked.address);
      localStorage.setItem("privateKey", picked.privateKey);

      return account;
    },
  });
}
