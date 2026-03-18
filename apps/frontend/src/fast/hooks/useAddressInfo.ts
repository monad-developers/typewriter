import { useQuery } from "@tanstack/react-query";
import type { Address } from "viem";
import type { GetAccountResponse } from "../api";

export function useAddressInfo(address: Address | undefined, signedIn = false) {
  return useQuery({
    queryKey: ["addressInfo", address],
    enabled: signedIn && !!address,
    queryFn: async () => {
      const res = await fetch(`/api/fast/account?address=${address}`);
      if (!res.ok) throw new Error("Failed to fetch account");
      const data = (await res.json()) as GetAccountResponse;
      return { balance: data.balance, txCount: data.txCount };
    },
    staleTime: Number.POSITIVE_INFINITY,
  });
}
