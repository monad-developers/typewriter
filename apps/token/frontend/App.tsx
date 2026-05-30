import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  type Address,
  encodeAbiParameters,
  formatUnits,
  type Hex,
  parseSignature,
  parseUnits,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

type Account = { address: Address; privateKey: Hex };
type AddressInfo = { balance: string; nonce: string };
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
  to: Address;
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
type TokenSignature = { signature: Hex };

const STORAGE_PREFIX = "token";
const TRANSFER_TYPES = {
  Transfer: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "amount", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
} as const;
const TOKEN_SIGNATURE_PARAMS = [
  {
    type: "tuple",
    components: [
      { name: "keyType", type: "uint8" },
      { name: "rawSignature", type: "bytes" },
    ],
  },
] as const;

function shortAddr(addr: string) {
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
}

function relativeTime(timestamp: number) {
  const seconds = Math.floor((Date.now() - timestamp) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  return `${Math.floor(seconds / 3600)}h ago`;
}

function loadAccount(): Account | null {
  const address = localStorage.getItem(`${STORAGE_PREFIX}:address`);
  const privateKey = localStorage.getItem(`${STORAGE_PREFIX}:privateKey`);
  if (address?.startsWith("0x") !== true) return null;
  if (privateKey?.startsWith("0x") !== true) return null;
  return { address: address as Address, privateKey: privateKey as Hex };
}

function clearFastStorage() {
  localStorage.removeItem(`${STORAGE_PREFIX}:address`);
  localStorage.removeItem(`${STORAGE_PREFIX}:privateKey`);
  localStorage.removeItem(`${STORAGE_PREFIX}:boot-id`);
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
  const res = await fetch(params.path, {
    method,
    headers:
      params.body === undefined
        ? undefined
        : { "Content-Type": "application/json" },
    body: params.body === undefined ? undefined : JSON.stringify(params.body),
  });
  const duration = performance.now() - start;
  if (params.log === true) {
    params.record({
      method,
      path: params.path,
      duration,
      status: res.ok ? "ok" : "error",
    });
  }
  if (!res.ok) throw new Error(await res.text());
  return (await res.json()) as T;
}

async function signTransfer(params: {
  account: Account;
  config: { chainId: number; tokenAddress: Address };
  to: Address;
  amount: bigint;
  nonce: bigint;
  deadline: bigint;
}): Promise<TokenSignature> {
  const signer = privateKeyToAccount(params.account.privateKey);
  const signature = await signer.signTypedData({
    domain: {
      name: "Token",
      version: "1",
      chainId: params.config.chainId,
      verifyingContract: params.config.tokenAddress,
    },
    types: TRANSFER_TYPES,
    primaryType: "Transfer",
    message: {
      from: params.account.address,
      to: params.to,
      amount: params.amount,
      nonce: params.nonce,
      deadline: params.deadline,
    },
  });
  const { v, r, s } = parseSignature(signature);
  const rawSignature = encodeAbiParameters(
    [
      { name: "v", type: "uint8" },
      { name: "r", type: "bytes32" },
      { name: "s", type: "bytes32" },
    ],
    [Number(v), r, s],
  );
  return {
    signature: encodeAbiParameters(TOKEN_SIGNATURE_PARAMS, [
      { keyType: 2, rawSignature },
    ]),
  };
}

export function App() {
  const queryClient = useQueryClient();
  const [account, setAccount] = useState<Account | null>(null);
  const [amount, setAmount] = useState(1);
  const [to, setTo] = useState<Address>("" as Address);
  const [txs, setTxs] = useState<Tx[]>([]);
  const [logs, setLogs] = useState<RequestLogEntry[]>([]);
  const [error, setError] = useState<string | null>(null);

  const record = useCallback((entry: Omit<RequestLogEntry, "id">) => {
    setLogs((prev) =>
      [{ id: Date.now() + Math.random(), ...entry }, ...prev].slice(0, 24),
    );
  }, []);
  const configQuery = useQuery({
    queryKey: ["config"],
    queryFn: () =>
      request<{ chainId: number; tokenAddress: Address }>({
        path: "/api/config",
        record,
      }),
    staleTime: Infinity,
  });
  const bootIdQuery = useQuery({
    queryKey: ["boot-id"],
    queryFn: () => request<{ id: string }>({ path: "/api/boot-id", record }),
    staleTime: Infinity,
  });
  const accountQuery = useQuery({
    queryKey: ["account", account?.address],
    queryFn: () =>
      request<AddressInfo>({
        path: `/api/account/${account!.address}`,
        log: true,
        record,
      }),
    enabled: account !== null,
  });
  const addressesQuery = useQuery({
    queryKey: ["addresses"],
    queryFn: () => request<Address[]>({ path: "/api/addresses", record }),
    enabled: account !== null,
    refetchInterval: 5_000,
  });
  const config = configQuery.data ?? null;
  const info = accountQuery.data ?? null;
  const addresses = addressesQuery.data ?? [];
  const recipients = useMemo(
    () => addresses.filter((addr) => addr !== account?.address),
    [addresses, account],
  );

  useEffect(() => {
    if (bootIdQuery.isError) {
      clearFastStorage();
      return;
    }
    if (bootIdQuery.data === undefined) return;
    if (
      bootIdQuery.data.id !== localStorage.getItem(`${STORAGE_PREFIX}:boot-id`)
    ) {
      clearFastStorage();
      return;
    }
    setAccount(loadAccount());
  }, [bootIdQuery.data, bootIdQuery.isError]);

  useEffect(() => {
    if (to === ("" as Address) && recipients.length > 0) setTo(recipients[0]!);
  }, [recipients, to]);

  function watchStatus(id: number) {
    const events = new EventSource(`/api/mutation/${id}/status`);
    events.onmessage = (event) => {
      const { status } = JSON.parse(event.data) as { status: TxStatus };
      setTxs((prev) =>
        prev.map((tx) => (tx.id === id ? { ...tx, status } : tx)),
      );
      if (status === "finalized" || status === "rejected") events.close();
    };
    events.onerror = () => events.close();
  }

  const signInMutation = useMutation({
    mutationFn: () =>
      request<{
        address: Address;
        privateKey: Hex;
        bootId: string;
        mutationId: number;
      }>({ method: "POST", path: "/api/sign-in", record }),
    onMutate: () => {
      setError(null);
    },
    onSuccess: async (result) => {
      const next = { address: result.address, privateKey: result.privateKey };
      localStorage.setItem(`${STORAGE_PREFIX}:address`, result.address);
      localStorage.setItem(`${STORAGE_PREFIX}:privateKey`, result.privateKey);
      localStorage.setItem(`${STORAGE_PREFIX}:boot-id`, result.bootId);
      setAccount(next);
      await queryClient.invalidateQueries({ queryKey: ["addresses"] });
      await queryClient.invalidateQueries({
        queryKey: ["account", result.address],
      });
      setTxs((prev) => [
        {
          id: result.mutationId,
          status: "accepted",
          amount: 1000n,
          to: result.address,
          submissionLatency: 0,
          timestamp: Date.now(),
        },
        ...prev,
      ]);
      watchStatus(result.mutationId);
    },
    onError: (err) => {
      setError(err instanceof Error ? err.message : String(err));
    },
  });

  const transferMutation = useMutation({
    mutationFn: async () => {
      if (account === null || config === null) {
        throw new Error("missing account or config");
      }
      const current = await queryClient.fetchQuery({
        queryKey: ["account", account.address],
        queryFn: () =>
          request<AddressInfo>({
            path: `/api/account/${account.address}`,
            log: true,
            record,
          }),
      });
      const amountUnits = parseUnits(amount.toString(), 0);
      const deadline = BigInt(Math.floor(Date.now() / 1000) + 60);
      const signature = await signTransfer({
        account,
        config,
        to,
        amount: amountUnits,
        nonce: BigInt(current.nonce),
        deadline,
      });
      const start = performance.now();
      const result = await request<{ id: number }>({
        method: "POST",
        path: "/api/transfer",
        log: true,
        record,
        body: {
          from: account.address,
          to,
          amount: amountUnits.toString(),
          nonce: current.nonce,
          deadline: deadline.toString(),
          signature,
        },
      });
      return {
        id: result.id,
        amount: amountUnits,
        to,
        submissionLatency: performance.now() - start,
      };
    },
    onMutate: () => {
      setError(null);
    },
    onSuccess: async (result) => {
      setTxs((prev) => [
        {
          id: result.id,
          status: "accepted",
          amount: result.amount,
          to: result.to,
          submissionLatency: result.submissionLatency,
          timestamp: Date.now(),
        },
        ...prev,
      ]);
      if (account !== null) {
        await queryClient.invalidateQueries({
          queryKey: ["account", account.address],
        });
      }
      await queryClient.invalidateQueries({ queryKey: ["addresses"] });
      watchStatus(result.id);
    },
    onError: (err) => {
      setError(err instanceof Error ? err.message : String(err));
    },
  });

  const pending = signInMutation.isPending || transferMutation.isPending;

  if (bootIdQuery.isPending) return null;

  return (
    <div className="min-h-screen w-full flex flex-col">
      <div className="w-full border-b p-4 flex flex-col gap-2">
        <p className="text-lg">
          Transfer tokens through an FFCA FIFO runtime while tracing every API
          request and watching accepted mutations settle onchain.
        </p>
        <div className="flex items-center gap-3 text-sm">
          <a
            className="text-blue-500 hover:underline"
            href={
              config?.tokenAddress
                ? `https://testnet.monadscan.com/address/${config.tokenAddress}`
                : "/"
            }
          >
            Token contract ↗
          </a>
        </div>
      </div>
      {account === null ? (
        <main className="flex-1 flex items-center justify-center flex-col gap-3">
          <button
            type="button"
            disabled={pending}
            onClick={() => signInMutation.mutate()}
            className="px-4 py-2 border rounded hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {pending ? "Signing in..." : "Sign In"}
          </button>
          <p className="text-sm text-gray-400">
            Create a local account with the private key stored in the browser
            [demo only]
          </p>
          {error !== null ? <p className="error">{error}</p> : null}
        </main>
      ) : (
        <>
          <header className="w-full border-b p-4 h-80 flex gap-4">
            <div className="flex items-start gap-2 flex-col flex-1 min-w-0">
              <h2 className="text-2xl font-bold">Account Overview</h2>
              <code className="break-all">address: {account.address}</code>
              <code className="break-all">
                balance: {formatUnits(BigInt(info?.balance ?? "0"), 0)}
              </code>
              <code>transaction count: {info?.nonce ?? "..."}</code>
              <label className="flex items-center gap-2">
                <code>gas sponsorship:</code>
                <input type="checkbox" checked readOnly />
              </label>
              <label className="flex items-center gap-2 cursor-not-allowed opacity-50">
                <code>session keys:</code>
                <input type="checkbox" disabled />
              </label>
            </div>
            <div className="border-l -my-4" />
            <div className="flex-1 min-w-0 overflow-y-auto flex flex-col gap-2">
              <h2 className="text-2xl font-bold">Request Log</h2>
              {logs.map((log) => (
                <code
                  key={log.id}
                  className={`text-xs border-b pb-1 ${log.status === "ok" ? "text-gray-500" : "text-red-500"}`}
                >
                  {log.method} {log.path} {Math.round(log.duration)}ms
                </code>
              ))}
            </div>
          </header>

          <section className="w-full border-b px-4 py-4 flex flex-col gap-2">
            <h2 className="text-2xl font-bold">Transfer Tokens</h2>
            <div className="flex items-center gap-4">
              <code>
                send{" "}
                <input
                  className="w-16 border px-1"
                  type="number"
                  min={0}
                  value={amount}
                  onChange={(e) =>
                    setAmount(Math.max(0, Number(e.target.value)))
                  }
                />{" "}
                to{" "}
                <select
                  className="border px-1"
                  value={to}
                  onChange={(e) => setTo(e.target.value as Address)}
                >
                  {recipients.map((addr) => (
                    <option key={addr} value={addr}>
                      {addr}
                    </option>
                  ))}
                </select>
              </code>
              <button
                type="button"
                disabled={pending || recipients.length === 0}
                onClick={() => transferMutation.mutate()}
                className="border px-3 py-1 text-sm bg-green-500 text-white rounded-md disabled:opacity-50"
              >
                send
              </button>
            </div>
            {error !== null ? <p className="error">{error}</p> : null}
          </section>

          <section className="w-full p-4">
            <h2 className="text-2xl font-bold mb-4">View Transactions</h2>
            <table className="w-full border-collapse">
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
                      <code>{shortAddr(tx.to)}</code>
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
