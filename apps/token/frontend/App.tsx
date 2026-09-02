import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useState } from "react";
import superjson from "superjson";
import type { TypewriterManifest } from "typewriter";
import {
  authorizeMutation,
  deriveAccountID,
  getAuthorizationPayload,
  incrementNonce,
  KeyType,
  packP256Signature,
  type TypedMutation,
} from "typewriter/client";
import {
  type Address,
  bytesToHex,
  formatUnits,
  type Hex,
  hexToBytes,
  parseUnits,
  zeroHash,
} from "viem";
import { loadKeyPair, saveKeyPair } from "./key-store";

type Account = { accountID: Hex; nonce: bigint; keyPair: CryptoKeyPair };
type AccountInfo = { balance: bigint };
type TxStatus =
  | "received"
  | "enqueued"
  | "accepted"
  | "included"
  | "safe"
  | "finalized"
  | "rejected";
type Tx = {
  id: number;
  status: TxStatus;
  amount: bigint;
  to: Hex;
  submissionLatency: number;
  timestamp: number;
};
type RequestLogEntry = {
  id: number;
  method: string;
  path: string;
  status: "ok" | "error";
  duration: number;
};

const EMPTY_ACCOUNT_ID = "" as Hex;

const manifest = {
  chainId: 31337,
  address: "0x5FbDB2315678afecb367f032d93F642f64180aa3" as Address,
  mutations: {
    Transfer: {
      id: 0,
      params: [
        { name: "to", type: "bytes32" },
        { name: "amount", type: "uint256" },
      ],
    },
    Mint: {
      id: 1,
      params: [{ name: "amount", type: "uint256" }],
    },
    CreateAccount: {
      id: 253,
      params: [
        { name: "keyType", type: "uint8" },
        { name: "publicKey", type: "bytes" },
      ],
    },
    AddCredential: {
      id: 254,
      params: [
        { name: "expiration", type: "uint40" },
        { name: "keyType", type: "uint8" },
        { name: "permissions", type: "uint256" },
        { name: "publicKey", type: "bytes" },
      ],
    },
    RemoveCredential: {
      id: 255,
      params: [{ name: "credentialID", type: "uint64" }],
    },
  },
} as const satisfies TypewriterManifest;

const ACCOUNT_STORAGE_KEY = `${manifest.chainId}:${manifest.address.toLowerCase()}`;

function shortID(value: string) {
  return `${value.slice(0, 8)}...${value.slice(-6)}`;
}

function relativeTime(timestamp: number) {
  const seconds = Math.floor((Date.now() - timestamp) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  return `${Math.floor(seconds / 3600)}h ago`;
}

async function loadAccount(): Promise<Account | null> {
  const accountID = localStorage.getItem(`${ACCOUNT_STORAGE_KEY}:accountID`);
  const nonce = localStorage.getItem(`${ACCOUNT_STORAGE_KEY}:nonce`);
  const keyPair = await loadKeyPair(ACCOUNT_STORAGE_KEY);
  if (accountID?.startsWith("0x") !== true || accountID.length !== 66) {
    return null;
  }
  if (nonce === null || keyPair === null) return null;

  try {
    return { accountID: accountID as Hex, nonce: BigInt(nonce), keyPair };
  } catch {
    return null;
  }
}

async function storeAccount(account: Account): Promise<void> {
  localStorage.setItem(`${ACCOUNT_STORAGE_KEY}:accountID`, account.accountID);
  localStorage.setItem(
    `${ACCOUNT_STORAGE_KEY}:nonce`,
    account.nonce.toString(),
  );
  await saveKeyPair(ACCOUNT_STORAGE_KEY, account.keyPair);
}

async function generateP256KeyPair(): Promise<CryptoKeyPair> {
  const generated = (await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const privateJwk = await crypto.subtle.exportKey("jwk", generated.privateKey);
  const privateKey = await crypto.subtle.importKey(
    "jwk",
    privateJwk,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
  return { privateKey, publicKey: generated.publicKey };
}

async function publicKeyHex(keyPair: CryptoKeyPair): Promise<Hex> {
  return bytesToHex(
    new Uint8Array(await crypto.subtle.exportKey("raw", keyPair.publicKey)),
  );
}

async function signPayload(keyPair: CryptoKeyPair, payload: Hex): Promise<Hex> {
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    keyPair.privateKey,
    Uint8Array.from(hexToBytes(payload)),
  );
  return packP256Signature(bytesToHex(new Uint8Array(signature)));
}

async function request<T>(params: {
  method?: "GET" | "POST";
  path: string;
  body?: unknown;
  log?: boolean;
  record: (entry: Omit<RequestLogEntry, "id">) => void;
}): Promise<T> {
  const start = performance.now();
  const method = params.method ?? "GET";
  const response = await fetch(params.path, {
    method,
    headers:
      params.body === undefined
        ? undefined
        : { "Content-Type": "application/json" },
    body:
      params.body === undefined ? undefined : superjson.stringify(params.body),
  });
  const duration = performance.now() - start;
  if (params.log === true) {
    params.record({
      method,
      path: params.path,
      duration,
      status: response.ok ? "ok" : "error",
    });
  }
  if (!response.ok) throw new Error(await response.text());
  return superjson.parse(await response.text()) as T;
}

export function App() {
  const queryClient = useQueryClient();
  const [account, setAccount] = useState<Account | null>(null);
  const [accountLoaded, setAccountLoaded] = useState(false);
  const [amount, setAmount] = useState(1);
  const [to, setTo] = useState<Hex>(EMPTY_ACCOUNT_ID);
  const [txs, setTxs] = useState<Tx[]>([]);
  const [logs, setLogs] = useState<RequestLogEntry[]>([]);
  const [error, setError] = useState<string | null>(null);

  const record = useCallback((entry: Omit<RequestLogEntry, "id">) => {
    setLogs((previous) =>
      [{ id: Date.now() + Math.random(), ...entry }, ...previous].slice(0, 24),
    );
  }, []);
  const accountQuery = useQuery({
    queryKey: ["account", account?.accountID],
    queryFn: () =>
      request<AccountInfo>({
        path: `/api/account/${account!.accountID}`,
        log: true,
        record,
      }),
    enabled: account !== null,
  });
  const accountIDsQuery = useQuery({
    queryKey: ["accountIDs"],
    queryFn: () => request<Hex[]>({ path: "/api/accountIds", record }),
    enabled: account !== null,
    refetchInterval: 5_000,
  });
  const info = accountQuery.data ?? null;
  const accountIDs = accountIDsQuery.data ?? [];
  const recipients = useMemo(
    () =>
      accountIDs.filter(
        (accountID) =>
          accountID.toLowerCase() !== account?.accountID.toLowerCase(),
      ),
    [accountIDs, account],
  );
  const recipientOptions = recipients.length === 0 ? [zeroHash] : recipients;

  useEffect(() => {
    let cancelled = false;
    void loadAccount().then((stored) => {
      if (cancelled) return;
      setAccount(stored);
      setAccountLoaded(true);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    setTo((current) => {
      if (recipients.length === 0) return zeroHash;
      if (
        current === EMPTY_ACCOUNT_ID ||
        current === zeroHash ||
        !recipients.includes(current)
      ) {
        return recipients[0] ?? zeroHash;
      }
      return current;
    });
  }, [recipients]);

  function watchStatus(id: number) {
    const events = new EventSource(`/api/mutation/${id}/status`);
    events.onmessage = (event) => {
      const { status } = JSON.parse(event.data) as { status: TxStatus };
      setTxs((previous) =>
        previous.map((tx) => (tx.id === id ? { ...tx, status } : tx)),
      );
      if (status === "finalized" || status === "rejected") events.close();
    };
    events.onerror = () => events.close();
  }

  const signInMutation = useMutation({
    mutationFn: async () => {
      const keyPair = await generateP256KeyPair();
      const publicKey = await publicKeyHex(keyPair);
      const createParams = { keyType: KeyType.P256, publicKey } as const;
      const accountID = deriveAccountID(createParams);
      await saveKeyPair(ACCOUNT_STORAGE_KEY, keyPair);
      const createMutation = {
        name: "CreateAccount",
        params: createParams,
        accountID,
        credentialID: 0n,
        nonce: 0n,
        expiration: 0n,
      } as const satisfies TypedMutation<typeof manifest, "CreateAccount">;
      const createSignature = await signPayload(
        keyPair,
        getAuthorizationPayload(manifest, createMutation),
      );
      const create = authorizeMutation(createMutation, createSignature);
      await request<{ id: number }>({
        method: "POST",
        path: "/api",
        record,
        body: create,
      });

      const mintMutation = {
        name: "Mint",
        params: { amount: 1_000n },
        accountID,
        credentialID: 0n,
        nonce: 0n,
        expiration: BigInt(Math.floor(Date.now() / 1000) + 60),
      } as const satisfies TypedMutation<typeof manifest, "Mint">;
      const mintSignature = await signPayload(
        keyPair,
        getAuthorizationPayload(manifest, mintMutation),
      );
      const mint = authorizeMutation(mintMutation, mintSignature);
      const startedAt = performance.now();
      const result = await request<{ id: number }>({
        method: "POST",
        path: "/api",
        log: true,
        record,
        body: mint,
      });
      return {
        account: {
          accountID,
          nonce: incrementNonce(mintMutation.nonce),
          keyPair,
        },
        mutationId: result.id,
        submissionLatency: performance.now() - startedAt,
      };
    },
    onMutate: () => setError(null),
    onSuccess: async (result) => {
      await storeAccount(result.account);
      setAccount(result.account);
      await queryClient.invalidateQueries({ queryKey: ["accountIDs"] });
      await queryClient.invalidateQueries({
        queryKey: ["account", result.account.accountID],
      });
      setTxs((previous) => [
        {
          id: result.mutationId,
          status: "accepted",
          amount: 1_000n,
          to: result.account.accountID,
          submissionLatency: result.submissionLatency,
          timestamp: Date.now(),
        },
        ...previous,
      ]);
      watchStatus(result.mutationId);
    },
    onError: (cause) =>
      setError(cause instanceof Error ? cause.message : String(cause)),
  });

  const transferMutation = useMutation({
    mutationFn: async () => {
      if (account === null) throw new Error("missing account");

      const amountUnits = parseUnits(amount.toString(), 0);
      const transferMutation = {
        name: "Transfer",
        params: { to, amount: amountUnits },
        accountID: account.accountID,
        credentialID: 0n,
        nonce: account.nonce,
        expiration: BigInt(Math.floor(Date.now() / 1000) + 60),
      } as const satisfies TypedMutation<typeof manifest, "Transfer">;
      const transferSignature = await signPayload(
        account.keyPair,
        getAuthorizationPayload(manifest, transferMutation),
      );
      const transfer = authorizeMutation(transferMutation, transferSignature);
      const startedAt = performance.now();
      const result = await request<{ id: number }>({
        method: "POST",
        path: "/api",
        log: true,
        record,
        body: transfer,
      });
      return {
        id: result.id,
        amount: amountUnits,
        to,
        nextNonce: incrementNonce(account.nonce),
        submissionLatency: performance.now() - startedAt,
      };
    },
    onMutate: () => setError(null),
    onSuccess: async (result) => {
      if (account === null) return;
      const nextAccount = { ...account, nonce: result.nextNonce };
      await storeAccount(nextAccount);
      setAccount(nextAccount);
      setTxs((previous) => [
        {
          id: result.id,
          status: "accepted",
          amount: result.amount,
          to: result.to,
          submissionLatency: result.submissionLatency,
          timestamp: Date.now(),
        },
        ...previous,
      ]);
      await queryClient.invalidateQueries({
        queryKey: ["account", account.accountID],
      });
      await queryClient.invalidateQueries({ queryKey: ["accountIDs"] });
      watchStatus(result.id);
    },
    onError: (cause) =>
      setError(cause instanceof Error ? cause.message : String(cause)),
  });

  const pending = signInMutation.isPending || transferMutation.isPending;
  if (!accountLoaded) return null;

  return (
    <div className="min-h-screen w-full flex flex-col">
      <div className="w-full border-b p-4 flex flex-col gap-2">
        <p className="text-lg">
          Transfer tokens with native Typewriter accounts while tracing API
          requests and watching accepted mutations settle onchain.
        </p>
        <a
          className="text-blue-500 hover:underline text-sm"
          href={
            manifest?.address
              ? `https://testnet.monadscan.com/address/${manifest.address}`
              : "/"
          }
        >
          Token contract
        </a>
      </div>
      {account === null ? (
        <main className="flex-1 flex items-center justify-center flex-col gap-3 p-6 text-center">
          <button
            type="button"
            disabled={pending}
            onClick={() => signInMutation.mutate()}
            className="px-4 py-2 border rounded hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {pending ? "Creating account..." : "Sign In"}
          </button>
          <p className="text-sm text-gray-400 max-w-md">
            Create a P-256 account. The signing key stays in IndexedDB and only
            the account ID and nonce are stored in localStorage.
          </p>
          {error !== null ? <p className="error">{error}</p> : null}
        </main>
      ) : (
        <>
          <header className="w-full border-b p-4 min-h-80 flex flex-col md:flex-row gap-4">
            <div className="flex items-start gap-2 flex-col flex-1 min-w-0">
              <h2 className="text-2xl font-bold">Account Overview</h2>
              <code className="break-all">account ID: {account.accountID}</code>
              <code>balance: {formatUnits(info?.balance ?? 0n, 0)}</code>
              <code className="break-all">
                nonce: {account.nonce.toString()}
              </code>
              <label className="flex items-center gap-2">
                <code>gas sponsorship:</code>
                <input type="checkbox" checked readOnly />
              </label>
              <label className="flex items-center gap-2">
                <code>credential 0:</code>
                <input type="checkbox" checked readOnly />
              </label>
            </div>
            <div className="border-t md:border-t-0 md:border-l md:-my-4" />
            <div className="flex-1 min-w-0 max-h-72 overflow-y-auto flex flex-col gap-2">
              <h2 className="text-2xl font-bold">Request Log</h2>
              {logs.map((log) => {
                const color = log.status === "ok" ? "#6b7280" : "#ef4444";
                return (
                  <div
                    key={log.id}
                    className="flex flex-wrap items-baseline gap-2 border-b pb-1 text-xs"
                  >
                    <span style={{ color, fontWeight: 600 }}>{log.method}</span>
                    <span style={{ color }}>{log.path}</span>
                    <span className="text-gray-400">
                      {Math.round(log.duration)}ms
                    </span>
                  </div>
                );
              })}
            </div>
          </header>

          <section className="w-full border-b px-4 py-4 flex flex-col gap-2">
            <h2 className="text-2xl font-bold">Transfer Tokens</h2>
            <div className="flex flex-wrap items-center gap-4">
              <code>
                send{" "}
                <input
                  className="w-16 border px-1"
                  type="number"
                  min={0}
                  value={amount}
                  onChange={(event) =>
                    setAmount(Math.max(0, Number(event.target.value)))
                  }
                />{" "}
                to{" "}
                <select
                  className="border px-1 max-w-72"
                  value={to}
                  onChange={(event) => setTo(event.target.value as Hex)}
                >
                  {recipientOptions.map((accountID) => (
                    <option key={accountID} value={accountID}>
                      {accountID}
                    </option>
                  ))}
                </select>
              </code>
              <button
                type="button"
                disabled={pending}
                onClick={() => transferMutation.mutate()}
                className="border px-3 py-1 text-sm bg-green-500 text-white rounded-md disabled:opacity-50"
              >
                send
              </button>
            </div>
            {error !== null ? <p className="error">{error}</p> : null}
          </section>

          <section className="w-full p-4 overflow-x-auto">
            <h2 className="text-2xl font-bold mb-4">View Transactions</h2>
            <table className="w-full border-collapse min-w-160">
              <thead>
                <tr className="border-b">
                  <th className="text-left py-2 pr-6">
                    <code>status</code>
                  </th>
                  <th className="text-left py-2 pr-6">
                    <code>amount</code>
                  </th>
                  <th className="text-left py-2 pr-6">
                    <code>to</code>
                  </th>
                  <th className="text-left py-2 pr-6">
                    <code>submission latency</code>
                  </th>
                  <th className="text-left py-2 pr-6">
                    <code>when</code>
                  </th>
                </tr>
              </thead>
              <tbody>
                {txs.map((tx) => (
                  <tr key={tx.id} className="border-b last:border-0">
                    <td className="py-2 pr-6">
                      <code>{tx.status}</code>
                    </td>
                    <td className="py-2 pr-6">
                      <code>{formatUnits(tx.amount, 0)}</code>
                    </td>
                    <td className="py-2 pr-6">
                      <code>{shortID(tx.to)}</code>
                    </td>
                    <td className="py-2 pr-6">
                      <code>{Math.round(tx.submissionLatency)}ms</code>
                    </td>
                    <td className="py-2 pr-6">
                      <code>{relativeTime(tx.timestamp)}</code>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        </>
      )}
    </div>
  );
}
