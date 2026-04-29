import { DEFAULT_NON_ROOT_PERMISSIONS, EIP712_TYPES } from "order-book-sdk";
import * as Address from "ox/Address";
import * as Hash from "ox/Hash";
import type * as Hex from "ox/Hex";
import * as Secp256k1 from "ox/Secp256k1";
import * as Signature from "ox/Signature";
import * as TypedData from "ox/TypedData";
import { API_URL, CHAIN_ID, EXCHANGE_ADDRESS } from "./constants";

console.log(
  `Using API_URL=${API_URL}, CHAIN_ID=${CHAIN_ID}, EXCHANGE_ADDRESS=${EXCHANGE_ADDRESS}`,
);

function farDeadline(): bigint {
  return BigInt(Math.floor(Date.now() / 1000) + 86400);
}
const FETCH_TIMEOUT_MS = 30_000;

function domain() {
  return {
    name: "Exchange" as const,
    version: "1" as const,
    chainId: CHAIN_ID,
    verifyingContract: EXCHANGE_ADDRESS,
  };
}

export function sign(
  privateKey: Hex.Hex,
  primaryType: string,
  message: Record<string, unknown>,
): Hex.Hex {
  const payload = TypedData.getSignPayload({
    domain: domain(),
    types: EIP712_TYPES,
    primaryType: primaryType as keyof typeof EIP712_TYPES,
    message: message as never,
  });
  const sig = Secp256k1.sign({ payload, privateKey });
  return Signature.toHex(sig);
}

async function post(path: string, body: unknown) {
  const res = await fetch(`${API_URL}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body, (_k, v) =>
      typeof v === "bigint" ? v.toString() : v,
    ),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  const data = (await res.json()) as Record<string, unknown>;
  if (!res.ok) throw new Error(`${path} failed: ${data.error}`);
  return data;
}

import {
  type InstrumentConfig,
  priceToQ32,
  type TokenAmount,
} from "order-book-sdk";

export type Account = {
  privateKey: Hex.Hex;
  address: Address.Address;
  accountHex: Hex.Hex;
  keyId: number;
  nonceKey: bigint;
  seq: bigint;
};

type MutationOpts = { concurrent?: boolean };

function randomNonceKey(): bigint {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  let key = 0n;
  for (const b of bytes) key = (key << 8n) | BigInt(b);
  return key;
}

function reserveNonce(
  account: Account,
  opts?: MutationOpts,
): { nonce: bigint; rollback: () => void } {
  if (opts?.concurrent) {
    return { nonce: randomNonceKey() << 64n, rollback: () => {} };
  }
  const nonce = (account.nonceKey << 64n) | account.seq;
  account.seq++;
  return {
    nonce,
    rollback: () => {
      account.seq--;
    },
  };
}

async function postWithNonce<T>(
  rollback: () => void,
  path: string,
  body: unknown,
): Promise<T> {
  try {
    return (await post(path, body)) as T;
  } catch (err) {
    rollback();
    throw err;
  }
}

/** Round down to the nearest lot multiple. The contract rejects non-multiples. */
function lotAligned(raw: bigint, lotExp: number): bigint {
  const e = BigInt(lotExp);
  return (raw >> e) << e;
}

export async function createAccount(privateKey?: Hex.Hex): Promise<Account> {
  const pk = privateKey ?? Secp256k1.randomPrivateKey();
  const publicKey = Secp256k1.getPublicKey({ privateKey: pk });
  const address = Address.fromPublicKey(publicKey);
  const rootPublicKey =
    `0x000000000000000000000000${address.slice(2).toLowerCase()}` as Hex.Hex;
  const accountHex = Hash.keccak256(rootPublicKey);

  const existsRes = await fetch(`${API_URL}/api/account/${accountHex}/exists`, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  const { hasKeys } = (await existsRes.json()) as { hasKeys: boolean };

  if (!hasKeys) {
    await post("/api/initialize", {
      account: accountHex,
      expiry: 0,
      rootKeyType: 2,
      keyType: 2,
      permissions: DEFAULT_NON_ROOT_PERMISSIONS,
      rootPublicKey,
      publicKey: rootPublicKey,
      keyId: 0,
      nonce: "0",
      deadline: farDeadline().toString(),
      rawSignature: "0x",
    });
  }

  return {
    privateKey: pk,
    address,
    accountHex,
    keyId: 1,
    nonceKey: randomNonceKey(),
    seq: 0n,
  };
}

export async function estimateMarketOrder(params: {
  instrumentId: number;
  side: "buy" | "sell";
  quantityLots: bigint;
}): Promise<{
  fills: { quantity: bigint; price: number }[];
  filledQuantity: bigint;
  quoteQuantity: bigint;
}> {
  const url = `${API_URL}/api/estimate-market-order?instrumentId=${params.instrumentId}&side=${params.side}&quantity=${params.quantityLots}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  const data = (await res.json()) as Record<string, unknown>;
  if (!res.ok) throw new Error(`estimate-market-order failed: ${data.error}`);
  return {
    fills: (data.fills as { quantity: string; price: number }[]).map((f) => ({
      quantity: BigInt(f.quantity),
      price: f.price,
    })),
    filledQuantity: BigInt(data.filledQuantity as string),
    quoteQuantity: BigInt(data.quoteQuantity as string),
  };
}

export async function fetchPrice(instrumentId: number): Promise<{
  priceQ32: bigint | null;
  bestBidQ32: bigint | null;
  bestAskQ32: bigint | null;
  spreadQ32: bigint | null;
}> {
  const res = await fetch(
    `${API_URL}/api/price?instrumentId=${instrumentId}`,
    { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) },
  );
  const data = (await res.json()) as Record<string, unknown>;
  if (!res.ok) throw new Error(`fetch-price failed: ${data.error}`);
  const toBig = (v: unknown): bigint | null =>
    v === null || v === undefined ? null : BigInt(Math.round(v as number));
  return {
    priceQ32: toBig(data.price),
    bestBidQ32: toBig(data.bestBid),
    bestAskQ32: toBig(data.bestAsk),
    spreadQ32: toBig(data.spread),
  };
}

export async function fetchTicks(
  instrumentId: number,
  queries: { side: "buy" | "sell"; priceQ32: bigint }[],
): Promise<({ quantity: bigint; remainingQuantity: bigint; volume: number } | null)[]> {
  const res = await fetch(`${API_URL}/api/ticks`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      instrumentId,
      queries: queries.map((q) => ({
        side: q.side,
        priceQ32: q.priceQ32.toString(),
      })),
    }),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  const data = (await res.json()) as Record<string, unknown>;
  if (!res.ok) throw new Error(`fetch-ticks failed: ${data.error}`);
  return (data.ticks as (
    | { quantity: string; remainingQuantity: string; volume: number }
    | null
  )[]).map((t) =>
    t === null
      ? null
      : {
          quantity: BigInt(t.quantity),
          remainingQuantity: BigInt(t.remainingQuantity),
          volume: t.volume,
        },
  );
}

export type AccountOrder = {
  orderId: number;
  quantity: bigint;
  instrumentId: number;
  price: bigint;
  tickVolume: number;
  side: 0 | 1;
};

export async function fetchAccountOrders(
  account: Hex.Hex,
  instrumentId?: number,
): Promise<AccountOrder[]> {
  const url =
    instrumentId !== undefined
      ? `${API_URL}/api/account/${account}/orders?instrumentId=${instrumentId}`
      : `${API_URL}/api/account/${account}/orders`;
  const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  const data = (await res.json()) as Record<string, unknown>;
  if (!res.ok) throw new Error(`fetch-account-orders failed: ${data.error}`);
  return (data.orders as {
    orderId: number;
    quantity: string;
    instrumentId: number;
    price: string;
    tickVolume: number;
    side: 0 | 1;
  }[]).map((o) => ({
    orderId: o.orderId,
    quantity: BigInt(o.quantity),
    instrumentId: o.instrumentId,
    price: BigInt(o.price),
    tickVolume: o.tickVolume,
    side: o.side,
  }));
}

export async function estimateFillToPrice(params: {
  instrumentId: number;
  side: "buy" | "sell";
  priceQ32: bigint;
}): Promise<{
  fills: { quantity: bigint; price: number }[];
  totalQuantity: bigint;
  quoteQuantity: bigint;
}> {
  const url = `${API_URL}/api/estimate-fill-to-price?instrumentId=${params.instrumentId}&side=${params.side}&priceQ32=${params.priceQ32}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  const data = (await res.json()) as Record<string, unknown>;
  if (!res.ok) throw new Error(`estimate-fill-to-price failed: ${data.error}`);
  return {
    fills: (data.fills as { quantity: string; price: number }[]).map((f) => ({
      quantity: BigInt(f.quantity),
      price: f.price,
    })),
    totalQuantity: BigInt(data.totalQuantity as string),
    quoteQuantity: BigInt(data.quoteQuantity as string),
  };
}

export async function addInstrument(
  account: Account,
  instrument: {
    instrumentId: number;
    base: Address.Address;
    quote: Address.Address;
    baseLotExp: number;
    quoteLotExp: number;
  },
  opts?: MutationOpts,
) {
  const { nonce, rollback } = reserveNonce(account, opts);
  const deadline = farDeadline();
  const rawSignature = sign(account.privateKey, "AddInstrument", {
    instrumentId: BigInt(instrument.instrumentId),
    base: instrument.base,
    quote: instrument.quote,
    baseLotExp: instrument.baseLotExp,
    quoteLotExp: instrument.quoteLotExp,
    nonce,
    deadline,
  });
  return postWithNonce(rollback, "/api/add-instrument", {
    ...instrument,
    account: account.accountHex,
    keyId: account.keyId,
    nonce,
    deadline,
    rawSignature,
  });
}

export async function deposit(
  account: Account,
  params: { quantity: TokenAmount },
  opts?: MutationOpts,
) {
  const { quantity } = params;
  const { nonce, rollback } = reserveNonce(account, opts);
  const deadline = farDeadline();
  const rawSignature = sign(account.privateKey, "Deposit", {
    asset: quantity.asset,
    amount: quantity.raw,
    nonce,
    deadline,
  });
  return postWithNonce(rollback, "/api/mint", {
    asset: quantity.asset,
    amount: quantity.raw,
    account: account.accountHex,
    keyId: account.keyId,
    nonce,
    deadline,
    rawSignature,
  });
}

export async function limitOrder(
  account: Account,
  params: {
    instrument: InstrumentConfig;
    price: number;
    side: "buy" | "sell";
    quantity: TokenAmount;
  },
  opts?: MutationOpts,
) {
  const { instrument } = params;
  const bidOrAsk = params.side === "buy" ? 0 : 1;
  const q32Price = priceToQ32(params.price, instrument);
  const quantity = lotAligned(params.quantity.raw, instrument.baseLotExp);
  const { nonce, rollback } = reserveNonce(account, opts);
  const deadline = farDeadline();
  const rawSignature = sign(account.privateKey, "LimitOrder", {
    quantity,
    instrumentId: BigInt(instrument.id),
    price: q32Price,
    bidOrAsk,
    nonce,
    deadline,
  });
  return postWithNonce(rollback, "/api/limit-order", {
    quantity,
    instrumentId: instrument.id,
    price: q32Price,
    bidOrAsk,
    account: account.accountHex,
    keyId: account.keyId,
    nonce,
    deadline,
    rawSignature,
  });
}

export async function marketOrder(
  account: Account,
  params: {
    instrument: InstrumentConfig;
    side: "buy" | "sell";
    quantity: TokenAmount;
    minReceived: TokenAmount;
  },
  opts?: MutationOpts,
) {
  const { instrument } = params;
  const bidOrAsk = params.side === "buy" ? 0 : 1;
  const quantity = lotAligned(params.quantity.raw, instrument.baseLotExp);
  const receivedLotExp =
    params.side === "buy" ? instrument.baseLotExp : instrument.quoteLotExp;
  const minReceivedQuantity = lotAligned(
    params.minReceived.raw,
    receivedLotExp,
  );
  const { nonce, rollback } = reserveNonce(account, opts);
  const deadline = farDeadline();
  const rawSignature = sign(account.privateKey, "MarketOrder", {
    quantity,
    minReceivedQuantity,
    instrumentId: BigInt(instrument.id),
    bidOrAsk,
    nonce,
    deadline,
  });
  return postWithNonce(rollback, "/api/market-order", {
    quantity,
    minReceivedQuantity,
    instrumentId: instrument.id,
    bidOrAsk,
    account: account.accountHex,
    keyId: account.keyId,
    nonce,
    deadline,
    rawSignature,
  });
}

export async function closeOrder(
  account: Account,
  params: { orderId: number },
  opts?: MutationOpts,
) {
  const { nonce, rollback } = reserveNonce(account, opts);
  const deadline = farDeadline();
  const rawSignature = sign(account.privateKey, "CloseOrder", {
    orderId: BigInt(params.orderId),
    nonce,
    deadline,
  });
  return postWithNonce(rollback, "/api/close-order", {
    ...params,
    account: account.accountHex,
    keyId: account.keyId,
    nonce,
    deadline,
    rawSignature,
  });
}

export async function withdraw(
  account: Account,
  params: { quantity: TokenAmount },
  opts?: MutationOpts,
) {
  const { quantity } = params;
  const { nonce, rollback } = reserveNonce(account, opts);
  const deadline = farDeadline();
  const rawSignature = sign(account.privateKey, "Withdrawal", {
    asset: quantity.asset,
    amount: quantity.raw,
    nonce,
    deadline,
  });
  return postWithNonce(rollback, "/api/withdrawal", {
    asset: quantity.asset,
    amount: quantity.raw,
    account: account.accountHex,
    keyId: account.keyId,
    nonce,
    deadline,
    rawSignature,
  });
}
