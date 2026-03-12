import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { Address } from "viem";
import { parseEther } from "viem";
import { useAccountContext } from "@/contexts/AccountContext";
import { TOKEN_ABI, TOKEN_ADDRESS } from "../constants";
import { publicClient } from "../lib/client";

type TransferParams = {
  to: Address;
  amount: number;
};

export function useTransfer() {
  const { account, addTx, updateTx } = useAccountContext();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ to, amount }: TransferParams) => {
      if (!account) throw new Error("No account");

      let start = performance.now();

      const hash = await account.walletClient.writeContract({
        address: TOKEN_ADDRESS,
        abi: TOKEN_ABI,
        functionName: "transfer",
        args: [to, parseEther(amount.toString())],
        account: account.address,
        chain: account.walletClient.chain,
      });

      const preflightLatency = performance.now() - start;
      start = performance.now();

      addTx({
        hash,
        status: "pending",
        amount: parseEther(amount.toString()),
        to,
        cost: null,
        preflightLatency,
        submissionLatency: null,
        timestamp: Date.now(),
      });

      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      const submissionLatency = performance.now() - start;

      updateTx(hash, {
        status: "proposed",
        submissionLatency,
        cost: receipt.gasUsed * 102n * 10n ** 9n,
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["addressInfo", account?.address] });
    },
  });
}
