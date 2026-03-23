import { monadTestnet } from "viem/chains";

/**
 * Public Monad testnet RPC endpoints.
 * The configured BUN_PUBLIC_RPC_URL is always included in the race and tried
 * first (it is the "primary"). These additional endpoints are only used when
 * the chain is Monad testnet (chain ID 10143).
 */
const MONAD_TESTNET_RPC_URLS = [
  "https://testnet-rpc.monad.xyz",
  "https://monad-testnet.drpc.org",
  "https://rpc.ankr.com/monad_testnet",
  "https://monad-testnet.gateway.tatum.io",
  "https://monad-testnet.api.onfinality.io/public",
  "https://rpc-testnet.monadinfra.com",
  "https://monad-testnet-rpc.huginn.tech",
  "https://monad-testnet.gateway.tenderly.co",
  "https://10143.rpc.thirdweb.com",
];

type TransactionReceipt = Record<string, unknown>;

async function rpcCall(
  url: string,
  serializedTransaction: string,
): Promise<TransactionReceipt> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "eth_sendRawTransactionSync",
      params: [serializedTransaction],
    }),
  });

  if (!res.ok) {
    throw new Error(`RPC ${url} returned HTTP ${res.status}`);
  }

  const json = (await res.json()) as {
    result?: Record<string, unknown>;
    error?: { code: number; message: string };
  };

  if (json.error) {
    throw new Error(`RPC ${url}: ${json.error.message}`);
  }

  if (!json.result) {
    throw new Error(`RPC ${url}: missing result`);
  }

  return json.result as TransactionReceipt;
}

/**
 * Races `eth_sendRawTransactionSync` across all known Monad testnet RPCs.
 * Resolves as soon as the first endpoint responds without error.
 * On non-Monad chains, falls back to a single call to `primaryUrl`.
 */
export async function raceSendRawTransactionSync(
  primaryUrl: string,
  serializedTransaction: string,
  chainId: number,
): Promise<TransactionReceipt> {
  const urls = new Set<string>([primaryUrl]);

  if (chainId === monadTestnet.id) {
    for (const url of MONAD_TESTNET_RPC_URLS) {
      urls.add(url);
    }
  }

  const receipt = await Promise.any(
    [...urls].map((url) => rpcCall(url, serializedTransaction)),
  );

  return receipt;
}
