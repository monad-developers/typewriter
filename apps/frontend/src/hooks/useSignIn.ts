import { useMutation } from "@tanstack/react-query";
import { createWalletClient, encodeFunctionData, parseEther } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sendRawTransactionSync } from "viem/actions";
import { anvil } from "viem/chains";
import { useAccountContext } from "@/contexts/AccountContext";
import {
  type ANVIL_ACCOUNTS,
  RPC_URL,
  TOKEN_ABI,
  TOKEN_ADDRESS,
} from "../constants";
import { loggingTransport } from "../lib/loggingTransport";

type AvailableAccount = (typeof ANVIL_ACCOUNTS)[number];

export function useSignIn() {
  const { setAccount, addTx } = useAccountContext();

  return useMutation({
    mutationFn: async (accounts: readonly AvailableAccount[]) => {
      const picked = accounts[Math.floor(Math.random() * accounts.length)]!;
      const walletClient = createWalletClient({
        account: privateKeyToAccount(picked.privateKey),
        transport: loggingTransport(RPC_URL),
        chain: anvil,
      });

      const account = { ...picked, walletClient };
      setAccount(account);

      let start = performance.now();

      const data = encodeFunctionData({
        abi: TOKEN_ABI,
        functionName: "mint",
        args: [picked.address, parseEther("100")],
      });

      const request = await walletClient.prepareTransactionRequest({
        to: TOKEN_ADDRESS,
        data,
      });

      const preflightLatency = performance.now() - start;

      const serializedTx = await walletClient.signTransaction(request);

      start = performance.now();

      const receipt = await sendRawTransactionSync(walletClient, {
        serializedTransaction: serializedTx,
      });

      const submissionLatency = performance.now() - start;

      addTx(
        {
          hash: receipt.transactionHash,
          status: "proposed",
          amount: parseEther("100"),
          to: picked.address,
          cost: receipt.gasUsed * 102n * 10n ** 9n,
          blockNumber: receipt.blockNumber,
          preflightLatency,
          submissionLatency,
          timestamp: Date.now(),
        },
        picked.address,
      );

      localStorage.setItem("address", picked.address);
      localStorage.setItem("privateKey", picked.privateKey);

      return account;
    },
  });
}
