import { AbiParameters } from "ox";
import * as Address from "ox/Address";
import type * as Hex from "ox/Hex";
import * as OxHex from "ox/Hex";
import * as Secp256k1 from "ox/Secp256k1";
import * as Signature from "ox/Signature";
import superjson from "superjson";
import {
  authorizeMutation,
  deriveAccountID,
  getAuthorizationPayload,
  type TypedMutation,
} from "typewriter/client";
import { API_URL, CHAIN_ID, ORDER_BOOK_ADDRESS } from "./constants";

console.log(
  `Using API_URL=${API_URL}, CHAIN_ID=${CHAIN_ID}, ORDER_BOOK_ADDRESS=${ORDER_BOOK_ADDRESS}`,
);

const FETCH_TIMEOUT_MS = 30_000;

const manifest = {
  chainId: CHAIN_ID,
  address: ORDER_BOOK_ADDRESS,
  mutations: {
    CloseOrder: { id: 0, params: [{ name: "orderId", type: "uint64" }] },
    ChangeOrder: {
      id: 1,
      params: [
        { name: "orderId", type: "uint64" },
        { name: "price", type: "uint64" },
      ],
    },
    LimitOrder: {
      id: 2,
      params: [
        { name: "quantity", type: "uint256" },
        { name: "instrumentId", type: "uint64" },
        { name: "price", type: "uint64" },
        { name: "bidOrAsk", type: "uint8" },
      ],
    },
    MarketOrder: {
      id: 3,
      params: [
        { name: "quantity", type: "uint256" },
        { name: "minReceivedQuantity", type: "uint256" },
        { name: "instrumentId", type: "uint64" },
        { name: "bidOrAsk", type: "uint8" },
      ],
    },
    AddInstrument: {
      id: 4,
      params: [
        { name: "instrumentId", type: "uint64" },
        { name: "base", type: "address" },
        { name: "quote", type: "address" },
        { name: "baseLotExp", type: "uint8" },
        { name: "quoteLotExp", type: "uint8" },
      ],
    },
    Deposit: {
      id: 5,
      params: [
        { name: "asset", type: "address" },
        { name: "amount", type: "uint256" },
      ],
    },
    Withdrawal: {
      id: 6,
      params: [
        { name: "asset", type: "address" },
        { name: "amount", type: "uint256" },
      ],
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
} as const;

export function sign(
  account: Account,
  name: keyof typeof manifest.mutations,
  params: Record<string, unknown>,
  nonce: bigint,
) {
  const mutation = {
    name,
    params,
    accountID: account.accountHex,
    credentialID: BigInt(account.keyId),
    nonce,
    expiration: 0n,
  } as unknown as TypedMutation<typeof manifest, typeof name>;
  const signature = Secp256k1.sign({
    payload: getAuthorizationPayload(manifest, mutation),
    privateKey: account.privateKey,
  });
  const packedSignature = AbiParameters.encode(
    [
      { name: "v", type: "uint8" },
      { name: "r", type: "bytes32" },
      { name: "s", type: "bytes32" },
    ],
    [
      Signature.yParityToV(signature.yParity),
      OxHex.fromNumber(signature.r, { size: 32 }),
      OxHex.fromNumber(signature.s, { size: 32 }),
    ],
  );
  return authorizeMutation(mutation, packedSignature);
}

async function post(path: string, body: unknown) {
  const res = await fetch(`${API_URL}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: superjson.stringify(body),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  const data = superjson.parse(await res.text()) as Record<string, unknown>;
  if (!res.ok) throw new Error(`${path} failed: ${data.error}`);
  return data;
}

async function readJson<T>(res: Response): Promise<T> {
  return superjson.parse(await res.text()) as T;
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

async function postWithNonce<T>(params: {
  rollback: () => void;
  account: Account;
  mutation: unknown;
}): Promise<T> {
  try {
    return (await post("/api", params.mutation)) as T;
  } catch (err) {
    params.rollback();
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
  const accountHex = deriveAccountID({ keyType: 2, publicKey: rootPublicKey });

  const existsRes = await fetch(`${API_URL}/api/account/${accountHex}/exists`, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  const { exists } = await readJson<{ exists: boolean }>(existsRes);

  if (!exists) {
    const mutation = {
      name: "CreateAccount",
      params: { keyType: 2, publicKey: rootPublicKey },
      accountID: accountHex,
      credentialID: 0n,
      nonce: 0n,
      expiration: 0n,
    } as const satisfies TypedMutation<typeof manifest, "CreateAccount">;
    const authorization = authorizeMutation(
      mutation,
      (() => {
        const signature = Secp256k1.sign({
          payload: getAuthorizationPayload(manifest, mutation),
          privateKey: pk,
        });
        return AbiParameters.encode(
          [{ type: "uint8" }, { type: "bytes32" }, { type: "bytes32" }],
          [
            Signature.yParityToV(signature.yParity),
            OxHex.fromNumber(signature.r, { size: 32 }),
            OxHex.fromNumber(signature.s, { size: 32 }),
          ],
        );
      })(),
    );
    await post("/api", authorization);
  }

  return {
    privateKey: pk,
    address,
    accountHex,
    keyId: 0,
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
  const res = await fetch(url, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  const data = await readJson<Record<string, unknown>>(res);
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
  const res = await fetch(`${API_URL}/api/price?instrumentId=${instrumentId}`, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  const data = await readJson<Record<string, unknown>>(res);
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
): Promise<
  ({ quantity: bigint; remainingQuantity: bigint; volume: number } | null)[]
> {
  const res = await fetch(`${API_URL}/api/ticks`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: superjson.stringify({
      instrumentId,
      queries,
    }),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  const data = await readJson<Record<string, unknown>>(res);
  if (!res.ok) throw new Error(`fetch-ticks failed: ${data.error}`);
  return (
    data.ticks as ({
      quantity: string;
      remainingQuantity: string;
      volume: number;
    } | null)[]
  ).map((t) =>
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
  const res = await fetch(url, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  const data = await readJson<Record<string, unknown>>(res);
  if (!res.ok) throw new Error(`fetch-account-orders failed: ${data.error}`);
  return (
    data.orders as {
      orderId: number;
      quantity: string;
      instrumentId: number;
      price: string;
      tickVolume: number;
      side: 0 | 1;
    }[]
  ).map((o) => ({
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
  const res = await fetch(url, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  const data = await readJson<Record<string, unknown>>(res);
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
  const mutationParams = {
    instrumentId: BigInt(instrument.instrumentId),
    base: instrument.base,
    quote: instrument.quote,
    baseLotExp: instrument.baseLotExp,
    quoteLotExp: instrument.quoteLotExp,
  };
  return postWithNonce({
    rollback,
    account,
    mutation: sign(account, "AddInstrument", mutationParams, nonce),
  });
}

export async function deposit(
  account: Account,
  params: { quantity: TokenAmount },
  opts?: MutationOpts,
) {
  const { quantity } = params;
  const { nonce, rollback } = reserveNonce(account, opts);
  const mutationParams = { asset: quantity.asset, amount: quantity.raw };
  return postWithNonce({
    rollback,
    account,
    mutation: sign(account, "Deposit", mutationParams, nonce),
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
  const mutationParams = {
    quantity,
    instrumentId: BigInt(instrument.id),
    price: q32Price,
    bidOrAsk,
  };
  return postWithNonce({
    rollback,
    account,
    mutation: sign(account, "LimitOrder", mutationParams, nonce),
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
  const mutationParams = {
    quantity,
    minReceivedQuantity,
    instrumentId: BigInt(instrument.id),
    bidOrAsk,
  };
  return postWithNonce({
    rollback,
    account,
    mutation: sign(account, "MarketOrder", mutationParams, nonce),
  });
}

export async function closeOrder(
  account: Account,
  params: { orderId: number },
  opts?: MutationOpts,
) {
  const { nonce, rollback } = reserveNonce(account, opts);
  const mutationParams = { orderId: BigInt(params.orderId) };
  return postWithNonce({
    rollback,
    account,
    mutation: sign(account, "CloseOrder", mutationParams, nonce),
  });
}

export async function changeOrder(
  account: Account,
  params: { orderId: number; instrument: InstrumentConfig; price: number },
  opts?: MutationOpts,
) {
  const price = priceToQ32(params.price, params.instrument);
  const { nonce, rollback } = reserveNonce(account, opts);
  const mutationParams = {
    orderId: BigInt(params.orderId),
    price,
  };
  return postWithNonce({
    rollback,
    account,
    mutation: sign(account, "ChangeOrder", mutationParams, nonce),
  });
}

export async function withdraw(
  account: Account,
  params: { quantity: TokenAmount },
  opts?: MutationOpts,
) {
  const { quantity } = params;
  const { nonce, rollback } = reserveNonce(account, opts);
  const mutationParams = { asset: quantity.asset, amount: quantity.raw };
  return postWithNonce({
    rollback,
    account,
    mutation: sign(account, "Withdrawal", mutationParams, nonce),
  });
}
