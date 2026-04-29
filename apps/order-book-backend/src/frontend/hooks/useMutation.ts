import { useQuery } from "@tanstack/react-query";
import type { Hex } from "viem";
import type { ApiMutation } from "./useMutations";

export function useMutation(id: string | undefined) {
  return useQuery({
    queryKey: ["mutation", id],
    queryFn: async () => {
      const res = await fetch(`/api/mutation?id=${id}`);
      if (!res.ok) throw new Error(`Failed to fetch mutation ${id}`);
      return (await res.json()) as ApiMutation;
    },
    enabled: !!id,
    refetchInterval: (query) =>
      query.state.data?.status === "verified" ? false : 1000,
  });
}

export function useMutationByNonce(
  account: Hex | undefined,
  nonce: string | undefined,
) {
  return useQuery({
    queryKey: ["mutation", "byNonce", account, nonce],
    queryFn: async () => {
      const res = await fetch(
        `/api/mutation?account=${account}&nonce=${nonce}`,
      );
      if (!res.ok)
        throw new Error(`Failed to fetch mutation ${account}/${nonce}`);
      return (await res.json()) as ApiMutation;
    },
    enabled: !!account && !!nonce,
    refetchInterval: (query) =>
      query.state.data?.status === "verified" ? false : 1000,
  });
}
