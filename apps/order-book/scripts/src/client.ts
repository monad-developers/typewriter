import {
  authorizeWithSecp256k1,
  bidOrAsk,
  createSecp256k1Account,
  type InstrumentConfig,
  limitOrderParams,
  lotAligned,
  type OrderBookManifest,
  type OrderBookMutationName,
  priceToQ32,
  randomNonce,
  type Side,
  type TokenAmount,
} from "order-book-sdk";
import { type Hex, Secp256k1 } from "ox";
import superjson from "superjson";
import { incrementNonce, type TypedMutation } from "typewriter/client";
import { requiredEnv } from "./env";

const API_URL = requiredEnv("API_URL", "http://localhost:3000");
const FETCH_TIMEOUT_MS = 30_000;

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    ...init,
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  const text = await res.text();
  if (!res.ok) {
    const message = res.headers.get("Content-Type")?.includes("json")
      ? String(superjson.parse<{ error: unknown }>(text).error)
      : res.statusText;
    throw new Error(`${path} failed with HTTP ${res.status}: ${message}`);
  }
  return superjson.parse(text) as T;
}

function get<T>(path: string): Promise<T> {
  return request<T>(path);
}

export function post<T>(path: string, body: unknown): Promise<T> {
  return request<T>(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: superjson.stringify(body),
  });
}

export const manifest = await get<OrderBookManifest>("/api/manifest");

console.log(
  `Using API_URL=${API_URL}, chain ${manifest.chainId}, order book ${manifest.address}`,
);

export type Account = {
  privateKey: Hex.Hex;
  accountID: Hex.Hex;
  nonce: bigint;
};

type MutationOpts = { concurrent?: boolean };

export async function createAccount(privateKey?: Hex.Hex): Promise<Account> {
  const key = privateKey ?? Secp256k1.randomPrivateKey();
  const { accountID, mutation } = createSecp256k1Account(manifest, key);
  const { exists } = await get<{ exists: boolean }>(
    `/api/account/${accountID}/exists`,
  );
  if (!exists) await post("/api", mutation);
  return { privateKey: key, accountID, nonce: randomNonce() };
}

/** Retries `createAccount` until the backend accepts it. */
export async function createAccountRetrying(
  intervalMs: number,
): Promise<Account> {
  while (true) {
    try {
      return await createAccount();
    } catch (err) {
      console.error(
        "createAccount failed, retrying:",
        err instanceof Error ? err.message : err,
      );
      await Bun.sleep(intervalMs);
    }
  }
}

/**
 * Signs and posts a mutation. A concurrent mutation takes a random nonce
 * lane; any other takes the account's next nonce, and gives it back if the
 * post fails.
 */
async function submit<const name extends OrderBookMutationName>(
  account: Account,
  name: name,
  params: TypedMutation<OrderBookManifest, name>["params"],
  opts?: MutationOpts,
) {
  const nonce = opts?.concurrent ? randomNonce() : account.nonce;
  if (!opts?.concurrent) account.nonce = incrementNonce(nonce);
  const mutation = authorizeWithSecp256k1(manifest, account.privateKey, {
    name,
    params,
    accountID: account.accountID,
    credentialID: 0n,
    nonce,
    expiration: 0n,
  });
  try {
    return await post<{ executionIndex: bigint }>("/api", mutation);
  } catch (err) {
    if (!opts?.concurrent) account.nonce = nonce;
    throw err;
  }
}

export function deposit(
  account: Account,
  { quantity }: { quantity: TokenAmount },
  opts?: MutationOpts,
) {
  return submit(
    account,
    "Deposit",
    { asset: quantity.asset, amount: quantity.raw },
    opts,
  );
}

export function withdraw(
  account: Account,
  { quantity }: { quantity: TokenAmount },
  opts?: MutationOpts,
) {
  return submit(
    account,
    "Withdrawal",
    { asset: quantity.asset, amount: quantity.raw },
    opts,
  );
}

export function limitOrder(
  account: Account,
  params: {
    instrument: InstrumentConfig;
    price: number;
    side: Side;
    quantity: TokenAmount;
  },
  opts?: MutationOpts,
) {
  return submit(
    account,
    "LimitOrder",
    limitOrderParams(params.instrument, params),
    opts,
  );
}

export function marketOrder(
  account: Account,
  params: {
    instrument: InstrumentConfig;
    side: Side;
    quantity: TokenAmount;
    minReceived: TokenAmount;
  },
  opts?: MutationOpts,
) {
  const { instrument, side } = params;
  return submit(
    account,
    "MarketOrder",
    {
      quantity: lotAligned(params.quantity.raw, instrument.baseLotExp),
      minReceivedQuantity: lotAligned(
        params.minReceived.raw,
        side === "buy" ? instrument.baseLotExp : instrument.quoteLotExp,
      ),
      instrumentId: BigInt(instrument.id),
      bidOrAsk: bidOrAsk(side),
    },
    opts,
  );
}

export function closeOrder(
  account: Account,
  params: { orderId: number },
  opts?: MutationOpts,
) {
  return submit(
    account,
    "CloseOrder",
    { orderId: BigInt(params.orderId) },
    opts,
  );
}

export function changeOrder(
  account: Account,
  params: { orderId: number; instrument: InstrumentConfig; price: number },
  opts?: MutationOpts,
) {
  return submit(
    account,
    "ChangeOrder",
    {
      orderId: BigInt(params.orderId),
      price: priceToQ32(params.price, params.instrument),
    },
    opts,
  );
}

type Fill = { quantity: bigint; price: bigint };

export function estimateMarketOrder(params: {
  instrumentId: number;
  side: Side;
  quantityLots: bigint;
}) {
  return get<{
    fills: Fill[];
    filledQuantity: bigint;
    quoteQuantity: bigint;
  }>(
    `/api/estimate-market-order?instrumentId=${params.instrumentId}&side=${params.side}&quantity=${params.quantityLots}`,
  );
}

export function estimateFillToPrice(params: {
  instrumentId: number;
  side: Side;
  priceQ32: bigint;
}) {
  return get<{
    fills: Fill[];
    totalQuantity: bigint;
    quoteQuantity: bigint;
  }>(
    `/api/estimate-fill-to-price?instrumentId=${params.instrumentId}&side=${params.side}&priceQ32=${params.priceQ32}`,
  );
}

export function fetchPrice(instrumentId: number) {
  return get<{
    price: bigint | null;
    bestBid: bigint | null;
    bestAsk: bigint | null;
    spread: bigint | null;
  }>(`/api/price?instrumentId=${instrumentId}`);
}

export type Tick = {
  quantity: bigint;
  remainingQuantity: bigint;
  volume: number;
};

export async function fetchTicks(
  instrumentId: number,
  queries: { side: Side; priceQ32: bigint }[],
) {
  const { ticks } = await post<{ ticks: (Tick | null)[] }>("/api/ticks", {
    instrumentId,
    queries,
  });
  return ticks;
}

export type AccountOrder = {
  orderId: number;
  quantity: bigint;
  instrumentId: bigint;
  price: bigint;
  tickVolume: number;
  side: 0 | 1;
};

export async function fetchAccountOrders(
  accountID: Hex.Hex,
  instrumentId?: number,
) {
  const query =
    instrumentId === undefined ? "" : `?instrumentId=${instrumentId}`;
  const { orders } = await get<{ orders: AccountOrder[] }>(
    `/api/account/${accountID}/orders${query}`,
  );
  return orders;
}
