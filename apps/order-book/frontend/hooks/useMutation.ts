import { useQuery } from "@tanstack/react-query";
import { request } from "../lib/api";
import type { ApiMutation } from "./useMutations";

export function useMutation(executionIndex: string | undefined) {
  return useQuery({
    queryKey: ["mutation", executionIndex],
    queryFn: async () => {
      return request<ApiMutation>(
        `/api/mutation?executionIndex=${executionIndex}`,
      );
    },
    enabled: !!executionIndex,
    refetchInterval: (query) =>
      query.state.data?.status === "finalized" ? false : 1000,
  });
}
