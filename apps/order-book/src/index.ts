import { serve } from "bun";
import { drizzle } from "drizzle-orm/bun-sql/postgres";
import superjson from "superjson";
import { createTypewriter } from "typewriter";
import type { Address, Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import OrderBook from "../contracts/src/OrderBook.sol";
import index from "../frontend/index.html";
import { ORDER_BOOK_BATCH_ORDER } from "./app";
import { CHAIN, ORDER_BOOK_ADDRESS, RPC_URLS } from "./constants";
import {
  selectBlock,
  selectMutationByExecutionIndex,
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

const DATABASE_URL = process.env.DATABASE_URL;

const app = await createTypewriter(OrderBook, {
  address: ORDER_BOOK_ADDRESS,
  account: privateKeyToAccount(process.env.PRIVATE_KEY as `0x${string}`),
  chainId: CHAIN.id,
  rpcUrl: RPC_URLS,
  database: { url: DATABASE_URL, maxConnections: 25 },
  sequencing: {
    order: "batch",
    batchOrder: ORDER_BOOK_BATCH_ORDER,
  },
});

const readerDb = drizzle({
  client: new Bun.SQL({
    url: DATABASE_URL,
    max: 25,
  }),
});
const ACCOUNT_MUTATION_HISTORY_LIMIT = 50;
const TPS_WINDOW_MS = 10000;

// The mutation tables have no status column; derive it from `block_number`
// and the latest finalized block. Until a block finalizes after startup,
// included mutations read as "included".
let finalizedBlockNumber = -1n;
app.on("block", (block) => {
  if (block.status === "finalized" && block.number > finalizedBlockNumber) {
    finalizedBlockNumber = block.number;
  }
});

function withStatus(row: Record<string, unknown>) {
  const blockNumber = row.block_number as bigint | null;
  const status =
    blockNumber === null
      ? "accepted"
      : blockNumber <= finalizedBlockNumber
        ? "finalized"
        : "included";
  return { ...row, status };
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

function accountCredentials(account: Hex) {
  const credentials = app.accounts[account].credentials;
  const length = credentials.length;
  const out: {
    expiration: number;
    keyType: number;
    permissions: string;
    publicKey: Hex;
  }[] = [];
  for (let i = 0; i < length; i++) {
    const credential = credentials[i];
    out.push({
      expiration: Number(credential.expiration),
      keyType: Number(credential.keyType),
      permissions: String(credential.permissions),
      publicKey: credential.publicKey as Hex,
    });
  }
  return out;
}

function accountExists(account: Hex): boolean {
  return app.accounts[account].credentials.length > 0;
}

function accountOrders(account: Hex, instrumentId?: number) {
  const orders = app.state.accounts[account].orders;
  const length = orders.length;
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
    const orderInstrumentId = order.instrumentId;
    if (
      instrumentId !== undefined &&
      Number(orderInstrumentId) !== instrumentId
    ) {
      continue;
    }
    out.push({
      orderId: i,
      quantity: String(order.quantity),
      instrumentId: Number(orderInstrumentId),
      price: String(order.price),
      tickVolume: Number(order.tickVolume),
      side: Number(order.side) as 0 | 1,
    });
  }
  return out;
}

function accountBalances(account: Hex): Record<string, string> {
  const balanceProxy = app.state.accounts[account].balances;
  const assets = Object.keys(balanceProxy) as Address[];
  const balances: Record<string, string> = {};
  for (const asset of assets) {
    balances[asset] = String(balanceProxy[asset]);
  }
  return balances;
}

function accountNonces(account: Hex): Record<string, string> {
  const nonceProxy = app.accounts[account].nonces;
  const keys = Object.keys(nonceProxy);
  const nonces: Record<string, string> = {};
  for (const key of keys) {
    nonces[key] = String(nonceProxy[key as `${number}`]);
  }
  return nonces;
}

function getPrices(instrumentId: number, side: "bids" | "asks"): number[] {
  const instrument = app.state.instruments[`${instrumentId}`];
  const prices: number[] = [];
  let price = Number(side === "asks" ? instrument.bestAsk : instrument.bestBid);
  while (price !== 0) {
    prices.push(price);
    price = Number(instrument[side][`${price}`].next);
  }
  return prices;
}

function summarizePrice(
  instrumentId: number,
  bidPrices: number[],
  askPrices: number[],
) {
  let bestBid: number | null = null;
  let bestAsk: number | null = null;

  for (const price of bidPrices) {
    const remainingQuantity =
      app.state.instruments[`${instrumentId}`].bids[`${price}`]
        .remainingQuantity;
    if (remainingQuantity > 0n) {
      bestBid = price;
      break;
    }
  }
  for (const price of askPrices) {
    const remainingQuantity =
      app.state.instruments[`${instrumentId}`].asks[`${price}`]
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

function tickAt(
  instrumentId: number,
  side: "bids" | "asks",
  priceQ32: number,
): {
  quantity: string;
  remainingQuantity: string;
  volume: number;
} | null {
  const tick =
    app.state.instruments[String(instrumentId) as `${number}`][side][
      String(priceQ32) as `${number}`
    ];
  const quantity = tick.quantity;
  const remainingQuantity = tick.remainingQuantity;
  const volume = tick.volume;
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
    "/api/manifest": () => json(app.manifest),
    "/api/ping": () =>
      json({ pong: true }, { headers: { "Cache-Control": "no-store" } }),
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
          body.authorization === undefined
        ) {
          return json({ error: "Bad Request" }, { status: 400 });
        }

        const result = await app.execute(
          body as Parameters<typeof app.execute>[0],
        );
        return json({
          executionIndex: result.executionIndex,
          status: "accepted",
        });
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
        return json(mutations.map(withStatus));
      },
    },
    "/api/mutation": {
      GET: async (req) => {
        const url = new URL(req.url);
        const executionIndex = url.searchParams.get("executionIndex");
        if (executionIndex === null || !/^\d+$/.test(executionIndex)) {
          return json(
            { error: "executionIndex query parameter required (integer)" },
            { status: 400 },
          );
        }
        const mutation = await selectMutationByExecutionIndex(
          readerDb,
          app.schema,
          BigInt(executionIndex),
        );
        if (mutation === null) {
          return json({ error: "Mutation not found" }, { status: 404 });
        }
        return json(withStatus(mutation));
      },
    },
    "/api/account/:id/orders": {
      GET: (req) => {
        const account = req.params.id as Hex;
        if (account === null) {
          return json({ error: "Invalid account address" }, { status: 400 });
        }
        if (!accountExists(account)) {
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
        const account = req.params.id as Hex;
        if (account === null) {
          return json({ exists: false, hasKeys: false });
        }
        const exists = accountExists(account);
        return json({ exists, hasKeys: exists });
      },
    },
    "/api/account/:id": {
      GET: async (req) => {
        const account = req.params.id as Hex;
        if (account === null) {
          return json({ error: "Invalid account address" }, { status: 400 });
        }
        if (!accountExists(account)) {
          return json({ error: "account not found" }, { status: 404 });
        }
        const credentials = accountCredentials(account);
        const nonces = accountNonces(account);
        const orders = accountOrders(account);
        const balances = accountBalances(account);
        const mutations = await selectMutationsByAccount(
          readerDb,
          app.schema,
          account,
          ACCOUNT_MUTATION_HISTORY_LIMIT,
        );
        return json({
          address: account,
          credentials,
          nonces,
          orders,
          balances,
          mutations: mutations.map(withStatus),
        });
      },
    },
    "/api/balances": {
      GET: (req) => {
        const account = new URL(req.url).searchParams.get(
          "account",
        ) as Hex | null;
        if (account === null || !/^0x[0-9a-fA-F]{64}$/.test(account)) {
          return json(
            { error: "account query parameter required" },
            { status: 400 },
          );
        }
        if (!accountExists(account)) {
          return json({ error: "account not found" }, { status: 404 });
        }
        const balances = accountBalances(account);
        return json({ account, balances });
      },
    },
    "/api/price": {
      GET: (req) => {
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
        const bidPrices = getPrices(instrumentId, "bids");
        const askPrices = getPrices(instrumentId, "asks");
        return json(summarizePrice(instrumentId, bidPrices, askPrices));
      },
    },
    "/api/depth": {
      GET: (req) => {
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
        const bidPrices = getPrices(instrumentId, "bids");
        const askPrices = getPrices(instrumentId, "asks");
        const summary = summarizePrice(instrumentId, bidPrices, askPrices);
        const bidTotals: Record<number, string> = {};
        const askTotals: Record<number, string> = {};
        for (const bp of [1, 5, 25] as const) {
          let bidTotal = 0n;
          let askTotal = 0n;
          if (summary.price !== null) {
            for (const price of bidPrices) {
              if (price >= summary.price * (1 - bp / 10_000)) {
                const remainingQuantity =
                  app.state.instruments[`${instrumentId}`].bids[`${price}`]
                    .remainingQuantity;
                bidTotal += remainingQuantity;
              }
            }
            for (const price of askPrices) {
              if (price <= summary.price * (1 + bp / 10_000)) {
                const remainingQuantity =
                  app.state.instruments[`${instrumentId}`].asks[`${price}`]
                    .remainingQuantity;
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
        const ticks = body.queries.map((query) =>
          tickAt(
            body.instrumentId as number,
            query.side === "buy" ? "bids" : "asks",
            Number(query.priceQ32),
          ),
        );
        return json({ ticks });
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
        const parsedInstrumentId = Number(instrumentId);
        const prices = getPrices(
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
            app.state.instruments[`${parsedInstrumentId}`][
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
        const parsedInstrumentId = Number(instrumentId);
        const limitPrice = Number(priceQ32);
        const prices = getPrices(
          parsedInstrumentId,
          side === "buy" ? "asks" : "bids",
        );
        let totalQuantity = 0n;
        let quoteQuantity = 0n;
        const fills: { quantity: string; price: number }[] = [];
        for (const price of prices) {
          if (side === "buy" ? price > limitPrice : price < limitPrice) break;
          const remainingQuantity =
            app.state.instruments[`${parsedInstrumentId}`][
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
