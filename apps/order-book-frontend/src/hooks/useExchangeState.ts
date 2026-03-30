import { useQuery } from "@tanstack/react-query";
import type { State } from "../api";

export function useExchangeState() {
  return useQuery({
    queryKey: ["exchange-state"],
    queryFn: async () => {
      const res = await fetch("/api/state");
      if (!res.ok) throw new Error("Failed to fetch state");
      return (await res.json()) as State;
    },
    refetchInterval: 2000,
  });
}
