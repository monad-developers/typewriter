import { serve } from "bun";
import { like } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sql/postgres";
import { createFFCA } from "ffca";
import { EXCHANGE_STORAGE_LAYOUT } from "order-book-sdk";
import superjson from "superjson";
import type { Address, Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import index from "../frontend/index.html";
import {
  normalizeSignatureForContract,
  ORDER_BOOK_BATCH_ORDER,
  ORDER_BOOK_MUTATIONS,
  ORDER_BOOK_SIGNATURE_PARAMS,
  type OrderBookSignature,
} from "./app";
import { CHAIN, EXCHANGE_ADDRESS, RPC_URLS } from "./constants";
import {
  selectBlock,
  selectMutationById,
  selectMutationsByAccount,
  selectMutationsByBlock,
  selectRecentMutationCount,
} from "./db-queries";

if (process.env.PRIVATE_KEY === undefined) {
  throw new Error("PRIVATE_KEY env var is required");
}
if (process.env.DATABASE_URL === undefined) {
  throw new Error("DATABASE_URL env var is required");
}

const app = await createFFCA<
  typeof EXCHANGE_STORAGE_LAYOUT,
  typeof ORDER_BOOK_MUTATIONS,
  typeof ORDER_BOOK_SIGNATURE_PARAMS,
  "batch"
>({
  address: EXCHANGE_ADDRESS,
  domain: { name: "Exchange", version: "1" },
  signature: { params: ORDER_BOOK_SIGNATURE_PARAMS },
  storageLayout: EXCHANGE_STORAGE_LAYOUT,
  account: privateKeyToAccount(process.env.PRIVATE_KEY as `0x${string}`),
  chainId: CHAIN.id,
  rpcUrl: RPC_URLS,
  database: { url: process.env.DATABASE_URL, maxConnections: 25 },
  sequencing: {
    order: "batch",
    batchOrder: ORDER_BOOK_BATCH_ORDER,
  },
  mutations: ORDER_BOOK_MUTATIONS,
});

const readerDb = drizzle({
  client: new Bun.SQL({
    url: process.env.DATABASE_URL,
    max: 25,
  }),
});
const ACCOUNT_MUTATION_HISTORY_LIMIT = 50;
const TPS_WINDOW_MS = 10000;

async function knownPathChildren(prefix: string): Promise<string[]> {
  const rows = await readerDb
    .select({ path: app.schema.known_paths.path })
    .from(app.schema.known_paths)
    .where(like(app.schema.known_paths.path, `${prefix}[%`));
  const keys = new Set<string>();
  for (const { path } of rows) {
    const rest = path.slice(prefix.length);
    const match = /^\[([^\]]+)\]/.exec(rest);
    if (match !== null) keys.add(match[1]!);
  }
  return [...keys];
}

function eventStream(event: "batch" | "block"): Response {
  const textEncoder = new TextEncoder();
  let unsubscribe = () => {};
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (value: unknown) => {
        controller.enqueue(
          textEncoder.encode(
            `event: ${event}\ndata: ${superjson.stringify(value)}\n\n`,
          ),
        );
      };
      unsubscribe =
        event === "batch" ? app.on("batch", send) : app.on("block", send);
    },
    cancel() {
      unsubscribe();
    },
  });
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
    },
  });
}

function json(value: unknown, init?: ResponseInit): Response {
  return new Response(superjson.stringify(value), {
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers },
  });
}

async function accountKeys(account: Hex) {
  const keys = app.state.accounts[account].keys;
  const length = await keys.length;
  const out: {
    expiry: number;
    keyType: number;
    permissions: number;
    publicKey: Hex;
  }[] = [];
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
  return (await app.state.accounts[account].keys.length) > 0;
}

async function accountOrders(account: Hex, instrumentId?: number) {
  const orders = app.state.accounts[account].orders;
  const length = await orders.length;
  const out: {
    orderId: number;
    quantity: string;
    instrumentId: number;
    price: string;
    tickVolume: number;
    side: 0 | 1;
  }[] = [];
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
      quantity: String(quantity),
      instrumentId: Number(orderInstrumentId),
      price: String(price),
      tickVolume: Number(tickVolume),
      side: Number(side) as 0 | 1,
    });
  }
  return out;
}

async function accountBalances(account: Hex): Promise<Record<string, string>> {
  const balanceProxy = app.state.accounts[account].balances;
  const assets = (await knownPathChildren(
    `accounts[${account}].balances`,
  )) as Address[];
  const amounts = await Promise.all(assets.map((asset) => balanceProxy[asset]));
  const balances: Record<string, string> = {};
  for (let i = 0; i < assets.length; i++) {
    balances[assets[i] as string] = String(amounts[i]);
  }
  return balances;
}

async function accountNonces(account: Hex): Promise<Record<string, string>> {
  const nonceProxy = app.state.accounts[account].nonces;
  const keys = await knownPathChildren(`accounts[${account}].nonces`);
  const values = await Promise.all(
    keys.map((key) => nonceProxy[key as `${number}`]),
  );
  const nonces: Record<string, string> = {};
  for (let i = 0; i < keys.length; i++) {
    nonces[keys[i] as string] = String(values[i]);
  }
  return nonces;
}

async function getPrices(
  instrumentId: number,
  side: "bids" | "asks",
): Promise<number[]> {
  const prices = (
    await knownPathChildren(`instruments[${instrumentId}].${side}`)
  ).map(Number);
  return prices.sort((a, b) => (side === "asks" ? a - b : b - a));
}

async function summarizePrice(
  instrumentId: number,
  bidPrices: number[],
  askPrices: number[],
) {
  let bestBid: number | null = null;
  let bestAsk: number | null = null;

  for (const price of bidPrices) {
    const remainingQuantity =
      await app.state.instruments[`${instrumentId}`].bids[`${price}`]
        .remainingQuantity;
    if (remainingQuantity > 0n) {
      bestBid = price;
      break;
    }
  }
  for (const price of askPrices) {
    const remainingQuantity =
      await app.state.instruments[`${instrumentId}`].asks[`${price}`]
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
    app.state.instruments[String(instrumentId) as `${number}`][side][
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
    quantity: String(quantity),
    remainingQuantity: String(remainingQuantity),
    volume: Number(volume),
  };
}

serve({
  idleTimeout: 0,
  routes: {
    "/api/domain": () => json(app.domain),
    "/api": {
      POST: async (req) => {
        const parsedBody = superjson.parse(await req.text());
        const body =
          parsedBody !== null && typeof parsedBody === "object"
            ? (parsedBody as Record<string, unknown>)
            : {};
        if (
          typeof body.name !== "string" ||
          body.params === undefined ||
          body.signature === undefined
        ) {
          return json({ error: "Bad Request" }, { status: 400 });
        }

        const result = await app.execute({
          ...body,
          signature: normalizeSignatureForContract(
            body.signature as OrderBookSignature,
          ),
        } as Parameters<typeof app.execute>[0]);
        return json({ id: result.id, status: "accepted" });
      },
    },
    "/api/tps": {
      GET: async () => {
        const count = await selectRecentMutationCount(
          readerDb,
          app.schema,
          TPS_WINDOW_MS,
        );
        return json(count / (TPS_WINDOW_MS / 1000));
      },
    },
    "/api/events/blocks": { GET: () => eventStream("block") },
    "/api/events/batches": { GET: () => eventStream("batch") },
    "/api/blocks/:number": {
      GET: async (req) => {
        const number = req.params.number;
        if (!/^\d+$/.test(number)) {
          return json({ error: "Invalid block number" }, { status: 400 });
        }
        const block = await selectBlock(readerDb, app.schema, number);
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
        const mutations = await selectMutationsByBlock(
          readerDb,
          app.schema,
          block,
        );
        return json(mutations);
      },
    },
    "/api/mutation": {
      GET: async (req) => {
        const url = new URL(req.url);
        const idParam = url.searchParams.get("id");
        let mutation: Awaited<ReturnType<typeof selectMutationById>> = null;
        if (idParam !== null) {
          if (!/^\d+$/.test(idParam)) {
            return json({ error: "Invalid id" }, { status: 400 });
          }
          mutation = await selectMutationById(
            readerDb,
            app.schema,
            Number(idParam),
          );
        } else {
          return json({ error: "Query with id" }, { status: 400 });
        }
        if (mutation === null) {
          return json({ error: "Mutation not found" }, { status: 404 });
        }
        return json(mutation);
      },
    },
    "/api/account/:id/orders": {
      GET: async (req) => {
        const account = req.params.id as Hex;
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
        const account = req.params.id as Hex;
        if (account === null) {
          return json({ exists: false, hasKeys: false });
        }
        const exists = await accountExists(account);
        return json({ exists, hasKeys: exists });
      },
    },
    "/api/account/:id": {
      GET: async (req) => {
        const account = req.params.id as Hex;
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
          selectMutationsByAccount(
            readerDb,
            app.schema,
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
        const balances = await accountBalances(account);
        return json({ account, balances });
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
        const bidPrices = await getPrices(instrumentId, "bids");
        const askPrices = await getPrices(instrumentId, "asks");
        return json(await summarizePrice(instrumentId, bidPrices, askPrices));
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
        const instrumentId = Number(instrumentIdParam);
        const bidPrices = await getPrices(instrumentId, "bids");
        const askPrices = await getPrices(instrumentId, "asks");
        const summary = await summarizePrice(
          instrumentId,
          bidPrices,
          askPrices,
        );
        const bidTotals: Record<number, string> = {};
        const askTotals: Record<number, string> = {};
        for (const bp of [1, 5, 25] as const) {
          let bidTotal = 0n;
          let askTotal = 0n;
          if (summary.price !== null) {
            for (const price of bidPrices) {
              if (price >= summary.price * (1 - bp / 10_000)) {
                const remainingQuantity =
                  await app.state.instruments[`${instrumentId}`].bids[
                    `${price}`
                  ].remainingQuantity;
                bidTotal += remainingQuantity;
              }
            }
            for (const price of askPrices) {
              if (price <= summary.price * (1 + bp / 10_000)) {
                const remainingQuantity =
                  await app.state.instruments[`${instrumentId}`].asks[
                    `${price}`
                  ].remainingQuantity;
                askTotal += remainingQuantity;
              }
            }
          }
          bidTotals[bp] = bidTotal.toString();
          askTotals[bp] = askTotal.toString();
        }
        return json({ instrumentId, bids: bidTotals, asks: askTotals });
      },
    },
    "/api/ticks": {
      POST: async (req) => {
        const body = superjson.parse(await req.text()) as {
          instrumentId?: number;
          queries?: { side: "buy" | "sell"; priceQ32: string | bigint }[];
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
        const parsedInstrumentId = Number(instrumentId);
        const prices = await getPrices(
          parsedInstrumentId,
          side === "buy" ? "asks" : "bids",
        );
        const quantityLots = BigInt(quantity);
        let remaining = quantityLots;
        let quoteQuantity = 0n;
        const fills: { quantity: string; price: number }[] = [];
        for (const price of prices) {
          if (remaining === 0n) break;
          const available =
            await app.state.instruments[`${parsedInstrumentId}`][
              side === "buy" ? "asks" : "bids"
            ][`${price}`].remainingQuantity;
          if (available === 0n) continue;
          const fillLots = remaining < available ? remaining : available;
          quoteQuantity += (fillLots * BigInt(price)) >> 32n;
          remaining -= fillLots;
          fills.push({ quantity: fillLots.toString(), price });
        }
        if (remaining > 0n) {
          return json({ error: "insufficient liquidity" }, { status: 400 });
        }
        return json({
          fills,
          filledQuantity: quantityLots.toString(),
          quoteQuantity: quoteQuantity.toString(),
        });
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
        const parsedInstrumentId = Number(instrumentId);
        const limitPrice = Number(priceQ32);
        const prices = await getPrices(
          parsedInstrumentId,
          side === "buy" ? "asks" : "bids",
        );
        let totalQuantity = 0n;
        let quoteQuantity = 0n;
        const fills: { quantity: string; price: number }[] = [];
        for (const price of prices) {
          if (side === "buy" ? price > limitPrice : price < limitPrice) break;
          const remainingQuantity =
            await app.state.instruments[`${parsedInstrumentId}`][
              side === "buy" ? "asks" : "bids"
            ][`${price}`].remainingQuantity;
          if (remainingQuantity === 0n) continue;
          totalQuantity += remainingQuantity;
          quoteQuantity += (remainingQuantity * BigInt(price)) >> 32n;
          fills.push({ quantity: remainingQuantity.toString(), price });
        }
        return json({
          fills,
          totalQuantity: totalQuantity.toString(),
          quoteQuantity: quoteQuantity.toString(),
        });
      },
    },
    "/*": index,
  },
  development: process.env.NODE_ENV !== "production" && {
    hmr: true,
    console: true,
  },
});
