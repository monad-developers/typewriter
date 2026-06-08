import { useQuery } from "@tanstack/react-query";
import { request } from "../lib/api";

export type BlockResponse = {
  number: string;
  hash: `0x${string}`;
  timestamp: string;
};

export function useBlock(number: string | undefined) {
  return useQuery({
    queryKey: ["block", number],
    queryFn: async () => {
      return request<BlockResponse>(`/api/blocks/${number}`);
    },
    enabled: !!number,
  });
}
