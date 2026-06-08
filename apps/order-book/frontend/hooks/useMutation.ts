import { useQuery } from "@tanstack/react-query";
import { request } from "../lib/api";
import type { ApiMutation } from "./useMutations";

export function useMutation(id: string | undefined) {
  return useQuery({
    queryKey: ["mutation", id],
    queryFn: async () => {
      return request<ApiMutation>(`/api/mutation?id=${id}`);
    },
    enabled: !!id,
    refetchInterval: (query) =>
      query.state.data?.status === "finalized" ? false : 1000,
  });
}
