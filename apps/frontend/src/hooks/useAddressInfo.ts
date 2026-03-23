import { useQuery } from "@tanstack/react-query";
import { type Address, formatEther } from "viem";
import { TOKEN_ABI, TOKEN_ADDRESS } from "@/constants";
import { publicClient } from "../lib/client";
import { withRpcScope } from "../lib/rpcScope";

export function useAddressInfo(address: Address | undefined, signedIn = false) {
  return useQuery({
    queryKey: ["addressInfo", address],
    enabled: signedIn && !!address,
    queryFn: () =>
      withRpcScope("account overview", async () => {
        const [balance, txCount] = await Promise.all([
          publicClient.readContract({
            address: TOKEN_ADDRESS,
            abi: TOKEN_ABI,
            functionName: "balanceOf",
            args: [address as Address],
          }),
          publicClient.getTransactionCount({ address: address as Address }),
        ]);
        return { balance: formatEther(balance), txCount };
      }),
    staleTime: Number.POSITIVE_INFINITY,
  });
}
