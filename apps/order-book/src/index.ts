import { serve } from "bun";
import { drizzle } from "drizzle-orm/bun-sql/postgres";
import { createFFCA } from "ffca";
import { EXCHANGE_STORAGE_LAYOUT } from "order-book-sdk";
import type { Address, Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import index from "../frontend/index.html";
import {
  normalizeSignatureForContract,
  ORDER_BOOK_BATCH_ORDER,
  ORDER_BOOK_MUTATIONS,
  ORDER_BOOK_SIGNATURE_PARAMS,
  type OrderBookFFCAConfig,
  type OrderBookMutationName,
  type OrderBookSignature,
  type SubmittedOrderBookMutation,
} from "./app";
import { CHAIN, EXCHANGE_ADDRESS, RPC_URLS } from "./constants";
import {
  loadBlock,
  loadMutationByAccountNonce,
  loadMutationById,
  loadMutationsByAccount,
  loadMutationsByBlock,
  loadRecentMutationCount,
  type QueryDatabase,
} from "./db-queries";

if (process.env.DEPLOYER_PRIVATE_KEY === undefined) {
  throw new Error("DEPLOYER_PRIVATE_KEY env var is required");
}
if (process.env.DATABASE_URL === undefined) {
  throw new Error("DATABASE_URL env var is required");
}

const account = privateKeyToAccount(
  process.env.DEPLOYER_PRIVATE_KEY as `0x${string}`,
);
const database = { url: process.env.DATABASE_URL, maxConnections: 25 };
const readerConnection = new Bun.SQL({
  url: process.env.DATABASE_URL,
  max: 25,
});

const config = {
  address: EXCHANGE_ADDRESS,
  domain: { name: "Exchange", version: "1" },
  signature: { params: ORDER_BOOK_SIGNATURE_PARAMS },
  storageLayout: EXCHANGE_STORAGE_LAYOUT,
  account,
  chainId: CHAIN.id,
  rpcUrl: RPC_URLS,
  database,
  sequencing: {
    order: "batch",
    batchOrder: ORDER_BOOK_BATCH_ORDER,
  },
  mutations: ORDER_BOOK_MUTATIONS,
} as const satisfies OrderBookFFCAConfig;

const app = await createFFCA<
  typeof EXCHANGE_STORAGE_LAYOUT,
  typeof ORDER_BOOK_MUTATIONS,
  typeof ORDER_BOOK_SIGNATURE_PARAMS
>(config);

const readerDb: QueryDatabase = drizzle({
  client: readerConnection,
});
const schema = app.schema;
const state = app.state;

const ACCOUNT_MUTATION_HISTORY_LIMIT = 50;
const TPS_WINDOW_MS = 10000;

type MutationStatus =
  | "submitted"
  | "accepted"
  | "included"
  | "safe"
  | "finalized";

type WireMutation = {
  id: number;
  batchId: number | null;
  blockNumber: string | null;
  status: MutationStatus;
  account: Hex;
  keyIndex: string | null;
  nonce: string | null;
  deadline: string;
  type: string;
  submittedAt: string;
  acceptedAt: string | null;
  includedAt: string | null;
  safeAt: string | null;
  finalizedAt: string | null;
  transactionHash: Hex | null;
  payload: unknown;
};

type RuntimeMutation = {
  id: number;
  status: string;
  name: OrderBookMutationName;
  params: Record<string, unknown>;
  signature: OrderBookSignature;
  resolution?: unknown;
};

const textEncoder = new TextEncoder();

function mutationType(name: string): string {
  return `${name[0]?.toLowerCase() ?? ""}${name.slice(1)}`;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}

function stringValue(value: unknown): string {
  return typeof value === "bigint" ? value.toString() : String(value);
}

function mutationPayload(mutation: RuntimeMutation): unknown {
  const params = mutation.params;
  switch (mutation.name) {
    case "Initialize":
      return {
        id: mutation.id,
        expiry: params.expiry,
        rootKeyType: params.rootKeyType,
        keyType: params.keyType,
        permissions: params.permissions,
        rootPublicKey: params.rootPublicKey,
        publicKey: params.publicKey,
      };
    case "Authorize":
      return {
        id: mutation.id,
        expiry: params.expiry,
        keyType: params.keyType,
        permissions: params.permissions,
        publicKey: params.publicKey,
      };
    case "Revoke":
      return { id: mutation.id, revokedKeyId: stringValue(params.keyId) };
    case "CloseOrder":
      return { id: mutation.id, orderId: stringValue(params.orderId) };
    case "ChangeOrder":
      return {
        id: mutation.id,
        orderId: stringValue(params.orderId),
        price: stringValue(params.price),
      };
    case "LimitOrder":
      return {
        id: mutation.id,
        quantity: stringValue(params.quantity),
        instrumentId: stringValue(params.instrumentId),
        price: stringValue(params.price),
        bidOrAsk: params.bidOrAsk,
      };
    case "MarketOrder": {
      const resolution = asRecord(mutation.resolution);
      const fills = Array.isArray(resolution.fills) ? resolution.fills : [];
      return {
        id: mutation.id,
        quantity: stringValue(params.quantity),
        minReceivedQuantity: stringValue(params.minReceivedQuantity),
        instrumentId: stringValue(params.instrumentId),
        bidOrAsk: params.bidOrAsk,
        fills: fills.map((fill) => {
          const row = asRecord(fill);
          return {
            quantity: stringValue(row.quantity),
            price: stringValue(row.price),
          };
        }),
      };
    }
    case "AddInstrument":
      return {
        id: mutation.id,
        instrumentId: stringValue(params.instrumentId),
        base: params.base,
        quote: params.quote,
        baseLotExp: params.baseLotExp,
        quoteLotExp: params.quoteLotExp,
      };
    case "Deposit":
      return {
        id: mutation.id,
        asset: params.asset,
        amount: stringValue(params.amount),
      };
    case "Withdrawal":
      return {
        id: mutation.id,
        asset: params.asset,
        amount: stringValue(params.amount),
      };
  }
}

function wireMutation(event: RuntimeMutation): WireMutation {
  const now = new Date().toISOString();
  const status: MutationStatus =
    event.status === "rejected"
      ? "submitted"
      : (event.status as MutationStatus);
  const nonce =
    event.params.nonce !== undefined ? stringValue(event.params.nonce) : null;
  const keyIndex = stringValue(event.signature.keyId);
  return {
    id: event.id,
    batchId: null,
    blockNumber: null,
    status,
    account: event.signature.account,
    keyIndex,
    nonce,
    deadline:
      event.params.deadline !== undefined
        ? stringValue(event.params.deadline)
        : "0",
    type: mutationType(event.name),
    submittedAt: now,
    acceptedAt: status === "submitted" ? null : now,
    includedAt:
      status === "included" || status === "safe" || status === "finalized"
        ? now
        : null,
    safeAt: status === "safe" || status === "finalized" ? now : null,
    finalizedAt: status === "finalized" ? now : null,
    transactionHash: null,
    payload: mutationPayload(event),
  };
}

function serverSentEvent(event: string, value: unknown): Uint8Array {
  return textEncoder.encode(
    `event: ${event}\ndata: ${JSON.stringify(value, (_, v) => {
      if (typeof v === "bigint") return v.toString();
      if (v === undefined) return null;
      if (typeof v === "function") return undefined;
      return v;
    })}\n\n`,
  );
}

function wireBatch(value: unknown): Record<string, unknown> {
  const batch = asRecord(value);
  const mutations = Array.isArray(batch.mutations) ? batch.mutations : [];
  return {
    ...batch,
    mutations: mutations.map((mutation) =>
      wireMutation(mutation as RuntimeMutation),
    ),
  };
}

function wireBlock(value: unknown): Record<string, unknown> {
  const block = asRecord(value);
  const batches = Array.isArray(block.batches) ? block.batches : [];
  return {
    ...block,
    number: block.number !== undefined ? stringValue(block.number) : undefined,
    timestamp:
      block.timestamp !== undefined ? stringValue(block.timestamp) : undefined,
    batches: batches.map((batch) => {
      const row = wireBatch(batch);
      return {
        ...row,
        mutationCount: Array.isArray(row.mutations) ? row.mutations.length : 0,
      };
    }),
  };
}

function wireEvent(event: "mutation" | "batch" | "block", value: unknown) {
  if (event === "mutation") return wireMutation(value as RuntimeMutation);
  if (event === "batch") return wireBatch(value);
  return wireBlock(value);
}

function eventStream(
  req: Request,
  event: "mutation" | "batch" | "block",
): Response {
  const stream = new TransformStream<Uint8Array, Uint8Array>();
  const writer = stream.writable.getWriter();
  let unsubscribe: (() => void) | undefined;
  const cleanup = () => {
    unsubscribe?.();
    req.signal.removeEventListener("abort", cleanup);
    writer.close().catch(() => {});
  };
  const write = (value: unknown) => {
    writer
      .write(serverSentEvent(event, wireEvent(event, value)))
      .catch(() => cleanup());
  };
  unsubscribe =
    event === "mutation"
      ? app.on("mutation", write)
      : event === "batch"
        ? app.on("batch", write)
        : app.on("block", write);
  req.signal.addEventListener("abort", cleanup, { once: true });
  return new Response(stream.readable, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
    },
  });
}

function json(value: unknown, init?: ResponseInit): Response {
  return new Response(
    JSON.stringify(value, (_, v) => (typeof v === "bigint" ? v.toString() : v)),
    {
      ...init,
      headers: { "Content-Type": "application/json", ...init?.headers },
    },
  );
}

function signatureFromBody(body: Record<string, unknown>): OrderBookSignature {
  return {
    account: body.account as Hex,
    keyId: BigInt(body.keyId as string | number | bigint),
    rawSignature: body.rawSignature as Hex,
  };
}

async function submit<const name extends OrderBookMutationName>(
  req: Request,
  name: name,
  buildParams: (
    body: Record<string, unknown>,
  ) => Extract<SubmittedOrderBookMutation, { name: name }>["params"],
) {
  const body = (await req.json()) as Record<string, unknown>;
  try {
    const signature = signatureFromBody(body);
    const result = await app.execute({
      name,
      params: buildParams(body),
      signature: normalizeSignatureForContract(signature),
    } as Parameters<typeof app.execute>[0]);
    const response: Record<string, unknown> = {
      id: result.id,
      status: "accepted",
    };
    const resolution = asRecord(
      (result as { resolution?: unknown }).resolution,
    );
    if (name === "MarketOrder" && Array.isArray(resolution.fills)) {
      response.fills = resolution.fills.map((fill) => {
        const row = asRecord(fill);
        return {
          quantity: stringValue(row.quantity),
          price: stringValue(row.price),
        };
      });
    }
    return json(response);
  } catch (error) {
    console.error(error);
    return json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 400 },
    );
  }
}

// -----------------------------------------------------------------------------
// State-driven read helpers
//
// All of these read through the ffca storage proxy. `ffca.state` is async — leaf
// reads return promises, sub-proxies are sync. Mapping enumeration is bounded
// to the keys registered via each mutation's `registerMappingKeys`, which ffca
// persists to `known_paths` and reloads on startup.

type AccountKeyRow = {
  expiry: number;
  keyType: number;
  permissions: number;
  publicKey: Hex;
};

type AccountOrderRow = {
  orderId: number;
  quantity: string;
  instrumentId: number;
  price: string;
  tickVolume: number;
  side: 0 | 1;
};

type PriceSummary = {
  instrumentId: number;
  price: number | null;
  bestBid: number | null;
  bestAsk: number | null;
  spread: number | null;
};

type TickSide = "bids" | "asks";

function parseAccountId(idParam: string): Hex | null {
  if (/^0x[0-9a-fA-F]{64}$/.test(idParam)) return idParam as Hex;
  return null;
}

async function accountKeys(account: Hex): Promise<AccountKeyRow[]> {
  const keys = state.accounts[account].keys;
  const length = await keys.length;
  const out: AccountKeyRow[] = [];
  for (let i = 0; i < length; i++) {
    const key = keys[i];
    const [expiry, keyType, permissions, publicKey] = await Promise.all([
      key.expiry,
      key.keyType,
      key.permissions,
      key.publicKey,
    ]);
    out.push({
      expiry: Number(expiry),
      keyType: Number(keyType),
      permissions: Number(permissions),
      publicKey: publicKey as Hex,
    });
  }
  return out;
}

async function accountExists(account: Hex): Promise<boolean> {
  const length = await state.accounts[account].keys.length;
  return length > 0;
}

async function accountOrders(
  account: Hex,
  instrumentId?: number,
): Promise<AccountOrderRow[]> {
  const orders = state.accounts[account].orders;
  const length = await orders.length;
  const out: AccountOrderRow[] = [];
  for (let i = 0; i < length; i++) {
    const order = orders[i];
    const [quantity, orderInstrumentId, price, tickVolume, side] =
      await Promise.all([
        order.quantity,
        order.instrumentId,
        order.price,
        order.tickVolume,
        order.side,
      ]);
    if (
      instrumentId !== undefined &&
      Number(orderInstrumentId) !== instrumentId
    ) {
      continue;
    }
    out.push({
      orderId: i,
      quantity: stringValue(quantity),
      instrumentId: Number(orderInstrumentId),
      price: stringValue(price),
      tickVolume: Number(tickVolume),
      side: Number(side) as 0 | 1,
    });
  }
  return out;
}

async function accountBalances(account: Hex): Promise<Record<string, string>> {
  const balanceProxy = state.accounts[account].balances;
  const assets = Object.keys(balanceProxy) as Address[];
  const amounts = await Promise.all(assets.map((asset) => balanceProxy[asset]));
  const balances: Record<string, string> = {};
  for (let i = 0; i < assets.length; i++) {
    balances[assets[i] as string] = stringValue(amounts[i]);
  }
  return balances;
}

async function accountNonces(account: Hex): Promise<Record<string, string>> {
  const nonceProxy = state.accounts[account].nonces;
  const keys = Object.keys(nonceProxy);
  const values = await Promise.all(
    keys.map((key) => nonceProxy[key as `${number}`]),
  );
  const nonces: Record<string, string> = {};
  for (let i = 0; i < keys.length; i++) {
    nonces[keys[i] as string] = stringValue(values[i]);
  }
  return nonces;
}

function getPrices(instrumentId: number, side: TickSide): number[] {
  const ticks = state.instruments[String(instrumentId) as `${number}`][side];
  const prices = Object.keys(ticks).map(Number);
  return prices.sort((a, b) => (side === "asks" ? a - b : b - a));
}

async function summarizePrice(
  instrumentId: number,
  bidPrices: number[],
  askPrices: number[],
): Promise<PriceSummary> {
  let bestBid: number | null = null;
  let bestAsk: number | null = null;

  for (const price of bidPrices) {
    const remainingQuantity =
      await state.instruments[`${instrumentId}`].bids[`${price}`]
        .remainingQuantity;
    if (remainingQuantity > 0n) {
      bestBid = price;
      break;
    }
  }
  for (const price of askPrices) {
    const remainingQuantity =
      await state.instruments[`${instrumentId}`].asks[`${price}`]
        .remainingQuantity;
    if (remainingQuantity > 0n) {
      bestAsk = price;
      break;
    }
  }

  const price =
    bestBid !== null && bestAsk !== null
      ? Math.round((bestBid + bestAsk) / 2)
      : (bestBid ?? bestAsk);
  return {
    instrumentId,
    price,
    bestBid,
    bestAsk,
    spread: bestBid !== null && bestAsk !== null ? bestAsk - bestBid : null,
  };
}

async function priceSummary(instrumentId: number): Promise<PriceSummary> {
  return summarizePrice(
    instrumentId,
    getPrices(instrumentId, "bids"),
    getPrices(instrumentId, "asks"),
  );
}

async function depthSummary(instrumentId: number) {
  const bidPrices = getPrices(instrumentId, "bids");
  const askPrices = getPrices(instrumentId, "asks");
  const summary = await summarizePrice(instrumentId, bidPrices, askPrices);
  const mid = summary.price;
  const bidTotals: Record<number, string> = {};
  const askTotals: Record<number, string> = {};
  for (const bp of [1, 5, 25] as const) {
    let bidTotal = 0n;
    let askTotal = 0n;
    if (mid !== null) {
      for (const price of bidPrices) {
        if (price >= mid * (1 - bp / 10_000)) {
          const remainingQuantity =
            await state.instruments[`${instrumentId}`].bids[`${price}`]
              .remainingQuantity;
          bidTotal += remainingQuantity;
        }
      }
      for (const price of askPrices) {
        if (price <= mid * (1 + bp / 10_000)) {
          const remainingQuantity =
            await state.instruments[`${instrumentId}`].asks[`${price}`]
              .remainingQuantity;
          askTotal += remainingQuantity;
        }
      }
    }
    bidTotals[bp] = bidTotal.toString();
    askTotals[bp] = askTotal.toString();
  }
  return { instrumentId, bids: bidTotals, asks: askTotals };
}

async function tickAt(
  instrumentId: number,
  side: "bids" | "asks",
  priceQ32: number,
): Promise<{
  quantity: string;
  remainingQuantity: string;
  volume: number;
} | null> {
  const tick =
    state.instruments[String(instrumentId) as `${number}`][side][
      String(priceQ32) as `${number}`
    ];
  const [quantity, remainingQuantity, volume] = await Promise.all([
    tick.quantity,
    tick.remainingQuantity,
    tick.volume,
  ]);
  if (quantity === 0n && remainingQuantity === 0n && Number(volume) === 0) {
    return null;
  }
  return {
    quantity: stringValue(quantity),
    remainingQuantity: stringValue(remainingQuantity),
    volume: Number(volume),
  };
}

async function estimateMarket(params: {
  instrumentId: number;
  side: "buy" | "sell";
  quantityLots: bigint;
}): Promise<
  | {
      fills: { quantity: string; price: number }[];
      filledQuantity: string;
      quoteQuantity: string;
    }
  | { error: string }
> {
  const prices = getPrices(
    params.instrumentId,
    params.side === "buy" ? "asks" : "bids",
  );
  let remaining = params.quantityLots;
  let quoteLots = 0n;
  const fills: { quantity: string; price: number }[] = [];
  for (const price of prices) {
    if (remaining === 0n) break;
    const available =
      await state.instruments[`${params.instrumentId}`][
        params.side === "buy" ? "asks" : "bids"
      ][`${price}`].remainingQuantity;
    if (available === 0n) continue;
    const fillLots = remaining < available ? remaining : available;
    quoteLots += (fillLots * BigInt(price)) >> 32n;
    remaining -= fillLots;
    fills.push({ quantity: fillLots.toString(), price });
  }
  if (remaining > 0n) return { error: "insufficient liquidity" };
  return {
    fills,
    filledQuantity: params.quantityLots.toString(),
    quoteQuantity: quoteLots.toString(),
  };
}

async function estimateFillToPrice(params: {
  instrumentId: number;
  side: "buy" | "sell";
  priceQ32: number;
}): Promise<{
  fills: { quantity: string; price: number }[];
  totalQuantity: string;
  quoteQuantity: string;
}> {
  const prices = getPrices(
    params.instrumentId,
    params.side === "buy" ? "asks" : "bids",
  );
  let totalQuantity = 0n;
  let quoteQuantity = 0n;
  const fills: { quantity: string; price: number }[] = [];
  for (const price of prices) {
    if (
      params.side === "buy" ? price > params.priceQ32 : price < params.priceQ32
    ) {
      break;
    }
    const remainingQuantity =
      await state.instruments[`${params.instrumentId}`][
        params.side === "buy" ? "asks" : "bids"
      ][`${price}`].remainingQuantity;
    if (remainingQuantity === 0n) continue;
    totalQuantity += remainingQuantity;
    quoteQuantity += (remainingQuantity * BigInt(price)) >> 32n;
    fills.push({ quantity: remainingQuantity.toString(), price });
  }
  return {
    fills,
    totalQuantity: totalQuantity.toString(),
    quoteQuantity: quoteQuantity.toString(),
  };
}

serve({
  idleTimeout: 0,
  routes: {
    "/api/initialize": {
      POST: (req) =>
        submit(req, "Initialize", (body) => ({
          account: body.account as Hex,
          expiry: Number(body.expiry),
          rootKeyType: Number(body.rootKeyType),
          keyType: Number(body.keyType),
          permissions: Number(body.permissions),
          rootPublicKey: body.rootPublicKey as Hex,
          publicKey: body.publicKey as Hex,
        })),
    },
    "/api/authorize": {
      POST: (req) =>
        submit(req, "Authorize", (body) => ({
          account: body.account as Hex,
          expiry: Number(body.expiry),
          keyType: Number(body.keyType),
          permissions: Number(body.permissions),
          publicKey: body.publicKey as Hex,
          nonce: BigInt(body.nonce as string | number | bigint),
          deadline: BigInt(body.deadline as string | number | bigint),
        })),
    },
    "/api/revoke": {
      POST: (req) =>
        submit(req, "Revoke", (body) => ({
          account: body.account as Hex,
          keyId: BigInt(body.keyId as string | number | bigint),
          nonce: BigInt(body.nonce as string | number | bigint),
          deadline: BigInt(body.deadline as string | number | bigint),
        })),
    },
    "/api/mint": {
      POST: (req) =>
        submit(req, "Deposit", (body) => ({
          asset: body.asset as Address,
          amount: BigInt(body.amount as string | number | bigint),
          nonce: BigInt(body.nonce as string | number | bigint),
          deadline: BigInt(body.deadline as string | number | bigint),
        })),
    },
    "/api/withdrawal": {
      POST: (req) =>
        submit(req, "Withdrawal", (body) => ({
          asset: body.asset as Address,
          amount: BigInt(body.amount as string | number | bigint),
          nonce: BigInt(body.nonce as string | number | bigint),
          deadline: BigInt(body.deadline as string | number | bigint),
        })),
    },
    "/api/market-order": {
      POST: (req) =>
        submit(req, "MarketOrder", (body) => ({
          quantity: BigInt(body.quantity as string | number | bigint),
          minReceivedQuantity: BigInt(
            body.minReceivedQuantity as string | number | bigint,
          ),
          instrumentId: Number(body.instrumentId),
          bidOrAsk: Number(body.bidOrAsk) as 0 | 1,
          nonce: BigInt(body.nonce as string | number | bigint),
          deadline: BigInt(body.deadline as string | number | bigint),
        })),
    },
    "/api/limit-order": {
      POST: (req) =>
        submit(req, "LimitOrder", (body) => ({
          quantity: BigInt(body.quantity as string | number | bigint),
          instrumentId: Number(body.instrumentId),
          price: BigInt(body.price as string | number | bigint),
          bidOrAsk: Number(body.bidOrAsk) as 0 | 1,
          nonce: BigInt(body.nonce as string | number | bigint),
          deadline: BigInt(body.deadline as string | number | bigint),
        })),
    },
    "/api/close-order": {
      POST: (req) =>
        submit(req, "CloseOrder", (body) => ({
          orderId: Number(body.orderId),
          nonce: BigInt(body.nonce as string | number | bigint),
          deadline: BigInt(body.deadline as string | number | bigint),
        })),
    },
    "/api/change-order": {
      POST: (req) =>
        submit(req, "ChangeOrder", (body) => ({
          orderId: Number(body.orderId),
          price: BigInt(body.price as string | number | bigint),
          nonce: BigInt(body.nonce as string | number | bigint),
          deadline: BigInt(body.deadline as string | number | bigint),
        })),
    },
    "/api/add-instrument": {
      POST: (req) =>
        submit(req, "AddInstrument", (body) => ({
          instrumentId: Number(body.instrumentId),
          base: body.base as Address,
          quote: body.quote as Address,
          baseLotExp: Number(body.baseLotExp),
          quoteLotExp: Number(body.quoteLotExp),
          nonce: BigInt(body.nonce as string | number | bigint),
          deadline: BigInt(body.deadline as string | number | bigint),
        })),
    },
    "/api/tps": {
      GET: async () => {
        const count = await loadRecentMutationCount(
          readerDb,
          schema,
          TPS_WINDOW_MS,
        );
        return json(count / (TPS_WINDOW_MS / 1000));
      },
    },
    "/api/events/blocks": { GET: (req) => eventStream(req, "block") },
    "/api/events/batches": { GET: (req) => eventStream(req, "batch") },
    "/api/events/mutations": { GET: (req) => eventStream(req, "mutation") },
    "/api/blocks/:number": {
      GET: async (req) => {
        const number = req.params.number;
        if (!/^\d+$/.test(number)) {
          return json({ error: "Invalid block number" }, { status: 400 });
        }
        const block = await loadBlock(readerDb, schema, number);
        if (block === null) {
          return json({ error: "Block not found" }, { status: 404 });
        }
        return json(block);
      },
    },
    "/api/mutations": {
      GET: async (req) => {
        const block = new URL(req.url).searchParams.get("block");
        if (block === null || !/^\d+$/.test(block)) {
          return json(
            { error: "block query parameter required (integer)" },
            { status: 400 },
          );
        }
        const mutations = await loadMutationsByBlock(readerDb, schema, block);
        return json(mutations);
      },
    },
    "/api/mutation": {
      GET: async (req) => {
        const url = new URL(req.url);
        const idParam = url.searchParams.get("id");
        const accountParam = url.searchParams.get("account");
        const nonceParam = url.searchParams.get("nonce");
        let mutation: Awaited<ReturnType<typeof loadMutationById>> = null;
        if (idParam !== null) {
          if (!/^\d+$/.test(idParam)) {
            return json({ error: "Invalid id" }, { status: 400 });
          }
          mutation = await loadMutationById(readerDb, schema, Number(idParam));
        } else if (accountParam !== null && nonceParam !== null) {
          if (
            !/^0x[0-9a-fA-F]{64}$/.test(accountParam) ||
            !/^\d+$/.test(nonceParam)
          ) {
            return json({ error: "Invalid account or nonce" }, { status: 400 });
          }
          mutation = await loadMutationByAccountNonce(
            readerDb,
            schema,
            accountParam as Hex,
            nonceParam,
          );
        } else {
          return json(
            { error: "Query with id, or account and nonce" },
            { status: 400 },
          );
        }
        if (mutation === null) {
          return json({ error: "Mutation not found" }, { status: 404 });
        }
        return json(mutation);
      },
    },
    "/api/account/:id/orders": {
      GET: async (req) => {
        const account = parseAccountId(req.params.id);
        if (account === null) {
          return json({ error: "Invalid account address" }, { status: 400 });
        }
        if (!(await accountExists(account))) {
          return json({ error: "account not found" }, { status: 404 });
        }
        const instrumentIdParam = new URL(req.url).searchParams.get(
          "instrumentId",
        );
        const instrumentId =
          instrumentIdParam !== null && /^\d+$/.test(instrumentIdParam)
            ? Number(instrumentIdParam)
            : undefined;
        return json({ orders: await accountOrders(account, instrumentId) });
      },
    },
    "/api/account/:id/exists": {
      GET: async (req) => {
        const account = parseAccountId(req.params.id);
        if (account === null) {
          return json({ exists: false, hasKeys: false });
        }
        const exists = await accountExists(account);
        return json({ exists, hasKeys: exists });
      },
    },
    "/api/account/:id": {
      GET: async (req) => {
        const account = parseAccountId(req.params.id);
        if (account === null) {
          return json({ error: "Invalid account address" }, { status: 400 });
        }
        if (!(await accountExists(account))) {
          return json({ error: "account not found" }, { status: 404 });
        }
        const [keys, nonces, orders, balances, mutations] = await Promise.all([
          accountKeys(account),
          accountNonces(account),
          accountOrders(account),
          accountBalances(account),
          loadMutationsByAccount(
            readerDb,
            schema,
            account,
            ACCOUNT_MUTATION_HISTORY_LIMIT,
          ),
        ]);
        return json({
          address: account,
          keys,
          nonces,
          orders,
          balances,
          mutations,
        });
      },
    },
    "/api/balances": {
      GET: async (req) => {
        const account = new URL(req.url).searchParams.get(
          "account",
        ) as Hex | null;
        if (account === null || !/^0x[0-9a-fA-F]{64}$/.test(account)) {
          return json(
            { error: "account query parameter required" },
            { status: 400 },
          );
        }
        if (!(await accountExists(account))) {
          return json({ error: "account not found" }, { status: 404 });
        }
        return json({ account, balances: await accountBalances(account) });
      },
    },
    "/api/price": {
      GET: async (req) => {
        const instrumentIdParam = new URL(req.url).searchParams.get(
          "instrumentId",
        );
        if (instrumentIdParam === null || !/^\d+$/.test(instrumentIdParam)) {
          return json(
            { error: "instrumentId query parameter required" },
            { status: 400 },
          );
        }
        const instrumentId = Number(instrumentIdParam);
        return json(await priceSummary(instrumentId));
      },
    },
    "/api/depth": {
      GET: async (req) => {
        const instrumentIdParam = new URL(req.url).searchParams.get(
          "instrumentId",
        );
        if (instrumentIdParam === null || !/^\d+$/.test(instrumentIdParam)) {
          return json(
            { error: "instrumentId query parameter required" },
            { status: 400 },
          );
        }
        return json(await depthSummary(Number(instrumentIdParam)));
      },
    },
    "/api/ticks": {
      POST: async (req) => {
        const body = (await req.json()) as {
          instrumentId?: number;
          queries?: { side: "buy" | "sell"; priceQ32: string }[];
        };
        if (
          typeof body.instrumentId !== "number" ||
          !Array.isArray(body.queries)
        ) {
          return json(
            { error: "instrumentId and queries required" },
            { status: 400 },
          );
        }
        const ticks = await Promise.all(
          body.queries.map((query) =>
            tickAt(
              body.instrumentId as number,
              query.side === "buy" ? "bids" : "asks",
              Number(query.priceQ32),
            ),
          ),
        );
        return json({ ticks });
      },
    },
    "/api/estimate-market-order": {
      GET: async (req) => {
        const url = new URL(req.url);
        const instrumentId = url.searchParams.get("instrumentId");
        const side = url.searchParams.get("side");
        const quantity = url.searchParams.get("quantity");
        if (
          instrumentId === null ||
          quantity === null ||
          (side !== "buy" && side !== "sell")
        ) {
          return json(
            { error: "instrumentId, side, and quantity required" },
            { status: 400 },
          );
        }
        const estimate = await estimateMarket({
          instrumentId: Number(instrumentId),
          side,
          quantityLots: BigInt(quantity),
        });
        if ("error" in estimate) return json(estimate, { status: 400 });
        return json(estimate);
      },
    },
    "/api/estimate-fill-to-price": {
      GET: async (req) => {
        const url = new URL(req.url);
        const instrumentId = url.searchParams.get("instrumentId");
        const side = url.searchParams.get("side");
        const priceQ32 = url.searchParams.get("priceQ32");
        if (
          instrumentId === null ||
          priceQ32 === null ||
          (side !== "buy" && side !== "sell")
        ) {
          return json(
            { error: "instrumentId, side, and priceQ32 required" },
            { status: 400 },
          );
        }
        return json(
          await estimateFillToPrice({
            instrumentId: Number(instrumentId),
            side,
            priceQ32: Number(priceQ32),
          }),
        );
      },
    },
    "/health": {
      GET: () => Response.json({ ok: true }),
    },
    "/*": index,
  },
  development: process.env.NODE_ENV !== "production" && {
    hmr: true,
    console: true,
  },
});
