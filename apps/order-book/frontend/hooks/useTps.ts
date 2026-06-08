import { useQuery } from "@tanstack/react-query";
import { request } from "../lib/api";

export function useTps() {
  return useQuery({
    queryKey: ["tps"],
    queryFn: async () => {
      return request<number>("/api/tps");
    },
    refetchInterval: 1000,
  });
}
