import { useMutation, useQueryClient } from "@tanstack/react-query";
import { type AccessList, type Address, encodeFunctionData, parseEther, parseGwei } from "viem";
import { monadTestnet } from "viem/chains";
import { sendRawTransactionSync } from "viem/actions";
import { useAccountContext } from "@/contexts/AccountContext";
import { CHAIN_ID, TOKEN_ABI, TOKEN_ADDRESS } from "../constants";
import { publicClient } from "../lib/client";
import { nonceManager } from "../lib/nonceManager";
import { withRpcScope } from "../lib/rpcScope";

// On Monad, baseFeePerGas has a minimum of 100 gwei and maxPriorityFeePerGas
// is effectively 0 — hardcode these to skip the corresponding RPC calls.
const MONAD_MAX_FEE_PER_GAS = parseGwei("100");
const MONAD_MAX_PRIORITY_FEE_PER_GAS = 0n;

type TransferParams = {
  to: Address;
  amount: number;
};

export function useTransfer() {
  const { account, addTx, accessListEnabled, preflightOptimizationsEnabled } = useAccountContext();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ to, amount }: TransferParams) => {
      if (!account) throw new Error("No account");

      let start = performance.now();

      const serializedTx = await withRpcScope(
        "transfer preflight",
        async () => {
          const data = encodeFunctionData({
            abi: TOKEN_ABI,
            functionName: "transfer",
            args: [to, parseEther(amount.toString())],
          });

          let accessList: AccessList | undefined;

          if (accessListEnabled) {
            const result = await publicClient.createAccessList({
              account: account.address,
              to: TOKEN_ADDRESS,
              data,
            });
            accessList = result.accessList;
          }

          // Preflight optimizations: use a local nonce manager to skip
          // eth_getTransactionCount, and on Monad hardcode gas params to skip
          // eth_maxPriorityFeePerGas and eth_getBlockByNumber.
          const nonce = preflightOptimizationsEnabled
            ? await nonceManager.getNonce(account.address)
            : undefined;

          const monadGasParams =
            preflightOptimizationsEnabled && CHAIN_ID === monadTestnet.id
              ? {
                  maxFeePerGas: MONAD_MAX_FEE_PER_GAS,
                  maxPriorityFeePerGas: MONAD_MAX_PRIORITY_FEE_PER_GAS,
                }
              : {};

          const request = await account.walletClient.prepareTransactionRequest({
            to: TOKEN_ADDRESS,
            data,
            ...(accessList ? { accessList } : {}),
            ...(nonce !== undefined ? { nonce } : {}),
            ...monadGasParams,
          });

          const serializedTx =
            await account.walletClient.signTransaction(request);

          return serializedTx;
        },
      );

      const preflightLatency = performance.now() - start;
      start = performance.now();

      const receipt = await withRpcScope("transfer", () =>
        sendRawTransactionSync(account.walletClient, {
          serializedTransaction: serializedTx,
        }),
      );

      const submissionLatency = performance.now() - start;

      addTx({
        hash: receipt.transactionHash,
        status: "proposed",
        amount: parseEther(amount.toString()),
        to,
        cost: receipt.gasUsed * receipt.effectiveGasPrice,
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
    onError: () => {
      if (account) nonceManager.reset(account.address);
    },
  });
}
