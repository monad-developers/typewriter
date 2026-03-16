import { useMutation, useQueryClient } from "@tanstack/react-query";
import { type Address, encodeFunctionData, parseEther } from "viem";
import { sendRawTransactionSync } from "viem/actions";
import { useAccountContext } from "@/contexts/AccountContext";
import { TOKEN_ABI, TOKEN_ADDRESS } from "../constants";
import { withRpcScope } from "../lib/rpcScope";

type TransferParams = {
  to: Address;
  amount: number;
};

export function useTransfer() {
  const { account, addTx } = useAccountContext();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ to, amount }: TransferParams) => {
      if (!account) throw new Error("No account");

      let start = performance.now();

      const { request, serializedTx } = await withRpcScope(
        "transfer preflight",
        async () => {
          const data = encodeFunctionData({
            abi: TOKEN_ABI,
            functionName: "transfer",
            args: [to, parseEther(amount.toString())],
          });

          const request =
            await account.walletClient.prepareTransactionRequest({
              to: TOKEN_ADDRESS,
              data,
            });

          const serializedTx =
            await account.walletClient.signTransaction(request);

          return { request, serializedTx };
        },
      );

      const preflightLatency = performance.now() - start;
      start = performance.now();

      const receipt = await sendRawTransactionSync(account.walletClient, {
        serializedTransaction: serializedTx,
      });

      const submissionLatency = performance.now() - start;

      addTx({
        hash: receipt.transactionHash,
        status: "proposed",
        amount: parseEther(amount.toString()),
        to,
        cost: receipt.gasUsed * 102n * 10n ** 9n,
        blockNumber: receipt.blockNumber,
        preflightLatency,
        submissionLatency,
        timestamp: Date.now(),
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: ["addressInfo", account?.address],
      });
    },
  });
}
