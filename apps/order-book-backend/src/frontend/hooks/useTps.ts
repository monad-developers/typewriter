import { useQuery } from "@tanstack/react-query";

export function useTps() {
  return useQuery({
    queryKey: ["tps"],
    queryFn: async () => {
      const res = await fetch("/api/tps");
      if (!res.ok) throw new Error("Failed to fetch tps");
      return (await res.json()) as number;
    },
    refetchInterval: 1000,
  });
}
