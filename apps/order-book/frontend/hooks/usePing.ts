import { useQuery } from "@tanstack/react-query";
import { request } from "../lib/api";

export function usePing() {
  return useQuery({
    queryKey: ["ping"],
    queryFn: async () => {
      const startedAt = performance.now();
      await request<{ pong: true }>("/api/ping", { cache: "no-store" });
      return performance.now() - startedAt;
    },
    refetchInterval: 2000,
    retry: false,
  });
}
