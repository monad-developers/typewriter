import { useQuery } from "@tanstack/react-query";
import type { Hex } from "viem";
import { request } from "../lib/api";

export type MutationStatus =
  | "submitted"
  | "accepted"
  | "included"
  | "safe"
  | "finalized";

export type ApiMutation = {
  id: number;
  executionIndex: bigint | null;
  blockNumber: bigint | null;
  blockHash: Hex | null;
  blockTimestamp: bigint | null;
  transactionHash: Hex | null;
  status: MutationStatus;
  acceptedAt: Date;
  includedAt: Date | null;
  safeAt: Date | null;
  finalizedAt: Date | null;
  authorization_account_id: Hex;
  authorization_credential_id: bigint;
  authorization_nonce: bigint;
  authorization_expiration: bigint;
  authorization_signature: Hex;
  [column: string]: unknown;
};

export function useMutations(blockNumber: string | undefined) {
  return useQuery({
    queryKey: ["mutations", blockNumber],
    queryFn: async () => {
      return request<ApiMutation[]>(`/api/mutations?block=${blockNumber}`);
    },
    enabled: !!blockNumber,
    refetchInterval: 1000,
  });
}
