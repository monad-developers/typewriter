import { useMutation } from "@tanstack/react-query";
import { createWalletClient, encodeFunctionData, parseEther } from "viem";
import type { Address, Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sendRawTransactionSync } from "viem/actions";
import { anvil } from "viem/chains";
import { useAccountContext } from "@/contexts/AccountContext";
import { RPC_URL, TOKEN_ABI, TOKEN_ADDRESS } from "../constants";
import { loggingTransport } from "../lib/loggingTransport";

export function useSignIn() {
  const { setAccount, addTx } = useAccountContext();

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
        chain: anvil,
      });

      const account = { address, privateKey, walletClient };
      setAccount(account);

      let start = performance.now();

      const data = encodeFunctionData({
        abi: TOKEN_ABI,
        functionName: "mint",
        args: [address, parseEther("100")],
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
          to: address,
          cost: receipt.gasUsed * 102n * 10n ** 9n,
          blockNumber: receipt.blockNumber,
          preflightLatency,
          submissionLatency,
          timestamp: Date.now(),
        },
        address,
      );

      localStorage.setItem("address", address);
      localStorage.setItem("privateKey", privateKey);

      return account;
    },
  });
}
