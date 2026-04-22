import { queryOptions, type QueryClient } from "@tanstack/react-query";
import type { Hex } from "viem";
import {
  clearSessionKey,
  loadSessionKey,
  saveSessionKey,
} from "./session-key-store";

export type Account = {
  accountId: Hex;
  keyId: number;
  nonceKey: bigint;
  sessionKey: CryptoKeyPair;
};

export function getNonce(account: Account): bigint {
  const seq = BigInt(localStorage.getItem("ob:seq") ?? "0");
  return (account.nonceKey << 64n) | seq;
}

export function incrementSeq() {
  const seq = BigInt(localStorage.getItem("ob:seq") ?? "0");
  localStorage.setItem("ob:seq", (seq + 1n).toString());
}

async function loadAccount(): Promise<Account | null> {
  const accountId = localStorage.getItem("ob:accountId") as Hex | null;
  const keyIdStr = localStorage.getItem("ob:keyId");
  const nonceKeyStr = localStorage.getItem("ob:nonceKey");
  const sessionKey = await loadSessionKey();
  if (accountId && keyIdStr && nonceKeyStr && sessionKey) {
    return {
      accountId,
      keyId: Number(keyIdStr),
      nonceKey: BigInt(nonceKeyStr),
      sessionKey,
    };
  }
  return null;
}

export const accountOptions = queryOptions({
  queryKey: ["account"],
  queryFn: loadAccount,
  staleTime: Number.POSITIVE_INFINITY,
});

export async function persistAccount(
  queryClient: QueryClient,
  account: Account | null,
) {
  localStorage.removeItem("ob:seq");
  if (account) {
    localStorage.setItem("ob:accountId", account.accountId);
    localStorage.setItem("ob:keyId", String(account.keyId));
    localStorage.setItem("ob:nonceKey", account.nonceKey.toString());
    // Persist the account ID across sign-outs so future sign-ins can skip
    // the identify() WebAuthn dialog and only show a single passkey prompt.
    localStorage.setItem("ob:lastAccountId", account.accountId);
    await saveSessionKey(account.sessionKey);
  } else {
    localStorage.removeItem("ob:accountId");
    localStorage.removeItem("ob:keyId");
    localStorage.removeItem("ob:nonceKey");
    await clearSessionKey();
  }
  queryClient.setQueryData(accountOptions.queryKey, account);
}
