import { useQuery } from "@tanstack/react-query";
import type { Address, Hex } from "viem";

export type MutationStatus =
  | "submitted"
  | "accepted"
  | "included"
  | "safe"
  | "finalized";

export type InitializePayload = {
  id: number;
  expiry: number;
  rootKeyType: number;
  keyType: number;
  permissions: number;
  rootPublicKey: Hex;
  publicKey: Hex;
};

export type AuthorizePayload = {
  id: number;
  expiry: number;
  keyType: number;
  permissions: number;
  publicKey: Hex;
};

export type RevokePayload = {
  id: number;
  revokedKeyId: string;
};

export type CloseOrderPayload = {
  id: number;
  orderId: string;
};

export type LimitOrderPayload = {
  id: number;
  quantity: string;
  instrumentId: string;
  price: string;
  bidOrAsk: number;
};

export type MarketOrderPayload = {
  id: number;
  quantity: string;
  minReceivedQuantity: string;
  instrumentId: string;
  bidOrAsk: number;
  fills: { quantity: string; price: string }[];
};

export type AddInstrumentPayload = {
  id: number;
  instrumentId: string;
  base: Address;
  quote: Address;
  baseLotExp: number;
  quoteLotExp: number;
};

export type DepositPayload = {
  id: number;
  asset: Address;
  amount: string;
};

export type WithdrawalPayload = {
  id: number;
  asset: Address;
  amount: string;
};

type MutationBase = {
  id: number;
  batchId: number | null;
  blockNumber: string | null;
  status: MutationStatus;
  account: Hex;
  accountSerial: number | null;
  keyIndex: string | null;
  nonce: string | null;
  deadline: string;
  submittedAt: string | null;
  acceptedAt: string | null;
  includedAt: string | null;
  safeAt: string | null;
  finalizedAt: string | null;
  transactionHash: Hex | null;
};

export type ApiMutation =
  | (MutationBase & { type: "initialize"; payload: InitializePayload | null })
  | (MutationBase & { type: "authorize"; payload: AuthorizePayload | null })
  | (MutationBase & { type: "revoke"; payload: RevokePayload | null })
  | (MutationBase & { type: "closeOrder"; payload: CloseOrderPayload | null })
  | (MutationBase & { type: "limitOrder"; payload: LimitOrderPayload | null })
  | (MutationBase & { type: "marketOrder"; payload: MarketOrderPayload | null })
  | (MutationBase & {
      type: "addInstrument";
      payload: AddInstrumentPayload | null;
    })
  | (MutationBase & { type: "deposit"; payload: DepositPayload | null })
  | (MutationBase & { type: "withdrawal"; payload: WithdrawalPayload | null });

export function useMutations(blockNumber: string | undefined) {
  return useQuery({
    queryKey: ["mutations", blockNumber],
    queryFn: async () => {
      const res = await fetch(`/api/mutations?block=${blockNumber}`);
      if (!res.ok)
        throw new Error(`Failed to fetch mutations for block ${blockNumber}`);
      return (await res.json()) as ApiMutation[];
    },
    enabled: !!blockNumber,
    refetchInterval: 1000,
  });
}
