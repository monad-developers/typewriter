import { useQuery } from "@tanstack/react-query";

export type BlockResponse = {
  number: string;
  hash: `0x${string}`;
  timestamp: string;
};

export function useBlock(number: string | undefined) {
  return useQuery({
    queryKey: ["block", number],
    queryFn: async () => {
      const res = await fetch(`/api/blocks/${number}`);
      if (!res.ok) throw new Error(`Failed to fetch block ${number}`);
      return (await res.json()) as BlockResponse;
    },
    enabled: !!number,
  });
}
