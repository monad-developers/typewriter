import { serve } from "bun";
import { createFFCA } from "ffca";
import { EXCHANGE_ABI } from "order-book-sdk";
import type { Address, Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import index from "../frontend/index.html";
import {
  normalizeSignatureForContract,
  ORDER_BOOK_SEQUENCE,
  ORDER_BOOK_SIGNATURE_PARAMS,
  type OrderBookMutationName,
  type OrderBookSignature,
  persistedMutations,
  type SubmittedOrderBookMutation,
} from "./app";
import { APP_SCHEMA } from "./app-schema";
import { CHAIN, EXCHANGE_ADDRESS, RPC_URLS } from "./constants";
import { createState, type State } from "./exchange";

if (process.env.DEPLOYER_PRIVATE_KEY === undefined) {
  throw new Error("DEPLOYER_PRIVATE_KEY env var is required");
}
if (process.env.DATABASE_URL === undefined) {
  throw new Error("DATABASE_URL env var is required");
}

const account = privateKeyToAccount(
  process.env.DEPLOYER_PRIVATE_KEY as `0x${string}`,
);
const database = {
  connection: new Bun.SQL({ url: process.env.DATABASE_URL, max: 25 }),
};
const initialState = createState();

const app = createFFCA({
  address: EXCHANGE_ADDRESS,
  domain: { name: "Exchange", version: "1" },
  abi: EXCHANGE_ABI,
  account,
  chainId: CHAIN.id,
  rpcUrl: RPC_URLS,
  database,
  state: { initial: initialState, schema: APP_SCHEMA },
  signature: { params: ORDER_BOOK_SIGNATURE_PARAMS },
  sequence: ORDER_BOOK_SEQUENCE,
  mutations: persistedMutations(initialState),
});

type MutationStatus =
  | "pending"
  | "accepted"
  | "proposed"
  | "voted"
  | "finalized"
  | "verified";

type WireMutation = {
  id: number;
  bundleId: number | null;
  blockNumber: string | null;
  status: MutationStatus;
  account: Hex;
  accountSerial: number | null;
  keyIndex: string | null;
  nonce: string | null;
  deadline: string;
  type: string;
  pendingAt: string;
  acceptedAt: string | null;
  proposedAt: string | null;
  votedAt: string | null;
  finalizedAt: string | null;
  verifiedAt: string | null;
  transactionHash: Hex | null;
  payload: unknown;
};

type RuntimeMutation = {
  id: number;
  status: string;
  name: OrderBookMutationName;
  args: Record<string, unknown>;
  signature: OrderBookSignature;
  resolution?: unknown;
};

const textEncoder = new TextEncoder();

function currentState(): State<bigint> {
  return app.state as State<bigint>;
}

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
  const args = mutation.args;
  switch (mutation.name) {
    case "Initialize":
      return {
        id: mutation.id,
        expiry: args.expiry,
        rootKeyType: args.rootKeyType,
        keyType: args.keyType,
        permissions: args.permissions,
        rootPublicKey: args.rootPublicKey,
        publicKey: args.publicKey,
      };
    case "Authorize":
      return {
        id: mutation.id,
        expiry: args.expiry,
        keyType: args.keyType,
        permissions: args.permissions,
        publicKey: args.publicKey,
      };
    case "Revoke":
      return { id: mutation.id, revokedKeyId: stringValue(args.keyId) };
    case "CloseOrder":
      return { id: mutation.id, orderId: stringValue(args.orderId) };
    case "ChangeOrder":
      return {
        id: mutation.id,
        orderId: stringValue(args.orderId),
        price: stringValue(args.price),
      };
    case "LimitOrder":
      return {
        id: mutation.id,
        quantity: stringValue(args.quantity),
        instrumentId: stringValue(args.instrumentId),
        price: stringValue(args.price),
        bidOrAsk: args.bidOrAsk,
      };
    case "MarketOrder": {
      const resolution = asRecord(mutation.resolution);
      const fills = Array.isArray(resolution.fills) ? resolution.fills : [];
      return {
        id: mutation.id,
        quantity: stringValue(args.quantity),
        minReceivedQuantity: stringValue(args.minReceivedQuantity),
        instrumentId: stringValue(args.instrumentId),
        bidOrAsk: args.bidOrAsk,
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
        instrumentId: stringValue(args.instrumentId),
        base: args.base,
        quote: args.quote,
        baseLotExp: args.baseLotExp,
        quoteLotExp: args.quoteLotExp,
      };
    case "Deposit":
      return {
        id: mutation.id,
        asset: args.asset,
        amount: stringValue(args.amount),
      };
    case "Withdrawal":
      return {
        id: mutation.id,
        asset: args.asset,
        amount: stringValue(args.amount),
      };
  }
}

function wireMutation(event: RuntimeMutation): WireMutation {
  const now = new Date().toISOString();
  const status: MutationStatus =
    event.status === "rejected" ? "pending" : (event.status as MutationStatus);
  const nonce =
    event.args.nonce !== undefined ? stringValue(event.args.nonce) : null;
  const keyIndex = stringValue(event.signature.keyId);
  return {
    id: event.id,
    bundleId: null,
    blockNumber: null,
    status,
    account: event.signature.account,
    accountSerial: null,
    keyIndex,
    nonce,
    deadline:
      event.args.deadline !== undefined
        ? stringValue(event.args.deadline)
        : "0",
    type: mutationType(event.name),
    pendingAt: now,
    acceptedAt: status === "pending" ? null : now,
    proposedAt:
      status === "proposed" ||
      status === "voted" ||
      status === "finalized" ||
      status === "verified"
        ? now
        : null,
    votedAt:
      status === "voted" || status === "finalized" || status === "verified"
        ? now
        : null,
    finalizedAt: status === "finalized" || status === "verified" ? now : null,
    verifiedAt: status === "verified" ? now : null,
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

function wireBundle(value: unknown): Record<string, unknown> {
  const bundle = asRecord(value);
  const mutations = Array.isArray(bundle.mutations) ? bundle.mutations : [];
  return {
    ...bundle,
    mutations: mutations.map((mutation) =>
      wireMutation(mutation as RuntimeMutation),
    ),
  };
}

function wireBlock(value: unknown): Record<string, unknown> {
  const block = asRecord(value);
  const bundles = Array.isArray(block.bundles) ? block.bundles : [];
  return {
    ...block,
    number: block.number !== undefined ? stringValue(block.number) : undefined,
    timestamp:
      block.timestamp !== undefined ? stringValue(block.timestamp) : undefined,
    bundles: bundles.map((bundle) => {
      const row = wireBundle(bundle);
      return {
        ...row,
        mutationCount: Array.isArray(row.mutations) ? row.mutations.length : 0,
      };
    }),
  };
}

function wireEvent(event: "mutation" | "bundle" | "block", value: unknown) {
  if (event === "mutation") return wireMutation(value as RuntimeMutation);
  if (event === "bundle") return wireBundle(value);
  return wireBlock(value);
}

function eventStream(event: "mutation" | "bundle" | "block"): Response {
  const stream = new TransformStream<Uint8Array, Uint8Array>();
  const writer = stream.writable.getWriter();
  const write = (value: unknown) => {
    writer
      .write(serverSentEvent(event, wireEvent(event, value)))
      .catch(() => unsubscribe());
  };
  const unsubscribe =
    event === "mutation"
      ? app.on("mutation", write)
      : event === "bundle"
        ? app.on("bundle", write)
        : app.on("block", write);
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

function notImplemented(todo: string): Response {
  return json({ error: "not implemented", todo }, { status: 501 });
}

function signatureFromBody(body: Record<string, unknown>): OrderBookSignature {
  return {
    account: body.account as Hex,
    keyId: BigInt(body.keyId as string | number | bigint),
    rawSignature: body.rawSignature as Hex,
  };
}

async function submit(
  req: Request,
  name: OrderBookMutationName,
  buildArgs: (
    body: Record<string, unknown>,
  ) => SubmittedOrderBookMutation["args"],
) {
  const body = (await req.json()) as Record<string, unknown>;
  try {
    const signature = signatureFromBody(body);
    const result = await app.execute({
      name,
      args: buildArgs(body),
      signature: normalizeSignatureForContract(currentState(), signature),
    });
    const response: Record<string, unknown> = {
      id: result.id,
      status: result.status,
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
    return json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 400 },
    );
  }
}

function accountByParam(
  idParam: string,
): { account: Hex; serial: number | null } | null {
  const accounts = Object.keys(currentState().accounts) as Hex[];
  if (/^\d+$/.test(idParam)) {
    const index = Number(idParam) - 1;
    const account = accounts[index];
    return account === undefined ? null : { account, serial: index + 1 };
  }
  if (!/^0x[0-9a-fA-F]{64}$/.test(idParam)) return null;
  const serial = accounts.indexOf(idParam as Hex);
  return { account: idParam as Hex, serial: serial === -1 ? null : serial + 1 };
}

function accountOrders(account: Hex, instrumentId?: number) {
  const orders = currentState().accounts[account]?.orders ?? [];
  return orders
    .map((order, orderId) => ({
      orderId,
      quantity: order.quantity.toString(),
      instrumentId: order.instrumentId,
      price: order.price.toString(),
      tickVolume: order.tickVolume,
      side: order.side,
    }))
    .filter(
      (order) =>
        instrumentId === undefined || order.instrumentId === instrumentId,
    );
}

function priceSummary(instrumentId: number) {
  const instrument = currentState().instruments[instrumentId];
  if (instrument === undefined) return null;
  const bidPrices = Object.entries(instrument.bids)
    .filter(([, tick]) => tick.remainingQuantity > 0n)
    .map(([price]) => Number(price));
  const askPrices = Object.entries(instrument.asks)
    .filter(([, tick]) => tick.remainingQuantity > 0n)
    .map(([price]) => Number(price));
  const bestBid = bidPrices.length > 0 ? Math.max(...bidPrices) : null;
  const bestAsk = askPrices.length > 0 ? Math.min(...askPrices) : null;
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

function estimateMarket(params: {
  instrumentId: number;
  side: "buy" | "sell";
  quantityLots: bigint;
}) {
  const instrument = currentState().instruments[params.instrumentId];
  if (instrument === undefined) return null;
  const ticks = params.side === "buy" ? instrument.asks : instrument.bids;
  const prices = Object.keys(ticks)
    .map(Number)
    .filter((price) => ticks[price]!.remainingQuantity > 0n)
    .sort((a, b) => (params.side === "buy" ? a - b : b - a));
  let remainingLots = params.quantityLots;
  let quoteLots = 0n;
  const fills: { quantity: string; price: number }[] = [];
  for (const price of prices) {
    if (remainingLots === 0n) break;
    const available = ticks[price]!.remainingQuantity;
    const fillLots = remainingLots < available ? remainingLots : available;
    quoteLots += (fillLots * BigInt(price)) >> 32n;
    remainingLots -= fillLots;
    fills.push({ quantity: fillLots.toString(), price });
  }
  if (remainingLots > 0n) return { error: "insufficient liquidity" };
  return {
    fills,
    filledQuantity: params.quantityLots.toString(),
    quoteQuantity: quoteLots.toString(),
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
          keyId: Number(body.keyId),
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
      GET: () =>
        notImplemented(
          "TODO: serve TPS from a persisted mutation/lifecycle query projection.",
        ),
    },
    "/api/events/blocks": { GET: () => eventStream("block") },
    "/api/events/bundles": { GET: () => eventStream("bundle") },
    "/api/events/mutations": { GET: () => eventStream("mutation") },
    "/api/blocks/:number": {
      GET: () =>
        notImplemented(
          "TODO: serve blocks from the upcoming Postgres query handler.",
        ),
    },
    "/api/mutations": {
      GET: () =>
        notImplemented(
          "TODO: serve mutations from the upcoming Postgres query handler.",
        ),
    },
    "/api/mutation": {
      GET: () =>
        notImplemented(
          "TODO: serve mutation history from the upcoming Postgres query handler.",
        ),
    },
    "/api/account/:id/orders": {
      GET: (req) => {
        const account = accountByParam(req.params.id)?.account;
        if (
          account === undefined ||
          currentState().accounts[account] === undefined
        ) {
          return json({ error: "account not found" }, { status: 404 });
        }
        const instrumentIdParam = new URL(req.url).searchParams.get(
          "instrumentId",
        );
        const instrumentId =
          instrumentIdParam !== null && /^\d+$/.test(instrumentIdParam)
            ? Number(instrumentIdParam)
            : undefined;
        return json({ orders: accountOrders(account, instrumentId) });
      },
    },
    "/api/account/:id/exists": {
      GET: (req) => {
        const account = accountByParam(req.params.id)?.account;
        const accountState =
          account === undefined ? undefined : currentState().accounts[account];
        return json({
          exists: accountState !== undefined,
          hasKeys: accountState !== undefined && accountState.keys.length > 0,
        });
      },
    },
    "/api/account/:id": {
      GET: (req) => {
        const resolved = accountByParam(req.params.id);
        if (resolved === null) {
          return json({ error: "Invalid account address" }, { status: 400 });
        }
        const accountState = currentState().accounts[resolved.account];
        if (accountState === undefined) {
          return json({ error: "account not found" }, { status: 404 });
        }
        const balances: Record<string, string> = {};
        for (const [asset, amount] of Object.entries(accountState.balances)) {
          balances[asset] = amount.toString();
        }
        const nonces: Record<string, string> = {};
        for (const [nonceKey, sequence] of Object.entries(
          accountState.nonces,
        )) {
          nonces[nonceKey] = sequence.toString();
        }
        return json({
          address: resolved.account,
          serial: resolved.serial,
          keys: accountState.keys,
          nonces,
          orders: accountOrders(resolved.account),
          balances,
          mutations: [],
        });
      },
    },
    "/api/balances": {
      GET: (req) => {
        const account = new URL(req.url).searchParams.get(
          "account",
        ) as Hex | null;
        if (account === null) {
          return json(
            { error: "account query parameter required" },
            { status: 400 },
          );
        }
        const accountState = currentState().accounts[account];
        if (accountState === undefined) {
          return json({ error: "account not found" }, { status: 404 });
        }
        const balances: Record<string, string> = {};
        for (const [asset, balance] of Object.entries(accountState.balances)) {
          balances[asset] = balance.toString();
        }
        return json({ account, balances });
      },
    },
    "/api/price": {
      GET: (req) => {
        const instrumentId = new URL(req.url).searchParams.get("instrumentId");
        if (instrumentId === null) {
          return json(
            { error: "instrumentId query parameter required" },
            { status: 400 },
          );
        }
        const summary = priceSummary(Number(instrumentId));
        if (summary === null) {
          return json({ error: "instrument not found" }, { status: 404 });
        }
        return json(summary);
      },
    },
    "/api/depth": {
      GET: (req) => {
        const instrumentIdParam = new URL(req.url).searchParams.get(
          "instrumentId",
        );
        if (instrumentIdParam === null) {
          return json(
            { error: "instrumentId query parameter required" },
            { status: 400 },
          );
        }
        const instrumentId = Number(instrumentIdParam);
        const instrument = currentState().instruments[instrumentId];
        const summary = priceSummary(instrumentId);
        if (instrument === undefined || summary === null) {
          return json({ error: "instrument not found" }, { status: 404 });
        }
        const mid = summary.price;
        const bids: Record<number, string> = {};
        const asks: Record<number, string> = {};
        for (const bp of [1, 5, 25] as const) {
          let bidTotal = 0n;
          let askTotal = 0n;
          if (mid !== null) {
            for (const [price, tick] of Object.entries(instrument.bids)) {
              if (Number(price) >= mid * (1 - bp / 10_000)) {
                bidTotal += tick.remainingQuantity;
              }
            }
            for (const [price, tick] of Object.entries(instrument.asks)) {
              if (Number(price) <= mid * (1 + bp / 10_000)) {
                askTotal += tick.remainingQuantity;
              }
            }
          }
          bids[bp] = bidTotal.toString();
          asks[bp] = askTotal.toString();
        }
        return json({ instrumentId, bids, asks });
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
        const instrument = currentState().instruments[body.instrumentId];
        if (instrument === undefined) {
          return json({ error: "instrument not found" }, { status: 404 });
        }
        return json({
          ticks: body.queries.map((query) => {
            const side =
              query.side === "buy" ? instrument.bids : instrument.asks;
            const tick = side[Number(query.priceQ32)];
            return tick === undefined
              ? null
              : {
                  quantity: tick.quantity.toString(),
                  remainingQuantity: tick.remainingQuantity.toString(),
                  volume: tick.volume,
                };
          }),
        });
      },
    },
    "/api/estimate-market-order": {
      GET: (req) => {
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
        const estimate = estimateMarket({
          instrumentId: Number(instrumentId),
          side,
          quantityLots: BigInt(quantity),
        });
        if (estimate === null) {
          return json({ error: "instrument not found" }, { status: 404 });
        }
        if ("error" in estimate) return json(estimate, { status: 400 });
        return json(estimate);
      },
    },
    "/api/estimate-fill-to-price": {
      GET: (req) => {
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
        const instrument = currentState().instruments[Number(instrumentId)];
        if (instrument === undefined) {
          return json({ error: "instrument not found" }, { status: 404 });
        }
        const anchor = Number(priceQ32);
        const ticks = side === "buy" ? instrument.asks : instrument.bids;
        const prices = Object.keys(ticks)
          .map(Number)
          .filter((price) => ticks[price]!.remainingQuantity > 0n)
          .sort((a, b) => (side === "buy" ? a - b : b - a));
        let totalQuantity = 0n;
        let quoteQuantity = 0n;
        const fills: { quantity: string; price: number }[] = [];
        for (const price of prices) {
          if (side === "buy" ? price > anchor : price < anchor) break;
          const quantityAtPrice = ticks[price]!.remainingQuantity;
          totalQuantity += quantityAtPrice;
          quoteQuantity += (quantityAtPrice * BigInt(price)) >> 32n;
          fills.push({ quantity: quantityAtPrice.toString(), price });
        }
        return json({
          fills,
          totalQuantity: totalQuantity.toString(),
          quoteQuantity: quoteQuantity.toString(),
        });
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
