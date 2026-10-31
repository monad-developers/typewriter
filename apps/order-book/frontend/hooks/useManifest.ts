import { useQuery } from "@tanstack/react-query";
import type { OrderBookManifest } from "order-book-sdk";
import { request } from "../lib/api";

export function useManifest() {
  return useQuery({
    queryKey: ["manifest"],
    queryFn: () => request<OrderBookManifest>("/api/manifest"),
    staleTime: Number.POSITIVE_INFINITY,
  });
}
