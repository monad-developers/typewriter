import { useQuery } from "@tanstack/react-query";
import type { Hex } from "viem";
import { request } from "../lib/api";

export type MutationStatus = "accepted" | "included" | "finalized";

/** A mutation table row, plus the `status` the server derives for it. */
export type ApiMutation = {
  execution_index: bigint;
  accepted_at: Date;
  block_number: bigint | null;
  block_hash: Hex | null;
  block_timestamp: bigint | null;
  transaction_index: number | null;
  transaction_hash: Hex | null;
  status: MutationStatus;
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
