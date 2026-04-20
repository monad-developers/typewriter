import { serve } from "bun";

const originalConsoleError = console.error.bind(console);
console.error = (...args: unknown[]) => {
  originalConsoleError(
    ...args.map((a) =>
      a instanceof Error
        ? Bun.inspect(a, { depth: Number.POSITIVE_INFINITY, colors: true })
        : a,
    ),
  );
};

import { desc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sql";
import type { Chain } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import * as schema from "./app-schema";
import { CHAIN, EXCHANGE_ADDRESS, RPC_URL } from "./constants";
import { checkConsistency, recoverState } from "./db";
import {
  type AddInstrument,
  type Authorize,
  type CloseOrder,
  type Deposit,
  decodeDeposit,
  decodeLimitOrder,
  decodeMarketOrder,
  decodeSigned,
  encodeState,
  type Initialize,
  type Instrument,
  type LimitOrder,
  type MarketOrder,
  MutationType,
  type Revoke,
  type Signed,
  type Tick,
} from "./exchange";

const BUCKET_SECONDS: Record<string, number> = {
  "1m": 60,
  "5m": 300,
  "15m": 900,
  "1h": 3600,
  "4h": 14400,
  "1d": 86400,
};

import index from "./frontend/index.html";
import { migrate } from "./migrate";
import { startRuntime } from "./runtime";

if (!process.env.DEPLOYER_PRIVATE_KEY) {
  throw new Error("DEPLOYER_PRIVATE_KEY env var is required");
}
const DEPLOYER_PRIVATE_KEY = process.env.DEPLOYER_PRIVATE_KEY as `0x${string}`;
const deployerAccount = privateKeyToAccount(DEPLOYER_PRIVATE_KEY);

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL env var is required");
}

const DATABASE_URL: string = process.env.DATABASE_URL;

const writerClient = new Bun.SQL({ url: DATABASE_URL, max: 1 });
const writerDb = drizzle({
  client: writerClient,
  schema,
  casing: "snake_case",
});

// @ts-expect-error migrate's BunSQLDatabase type doesn't carry schema
const schemaName = await migrate(writerDb, CHAIN.id, EXCHANGE_ADDRESS);

const readerClient = new Bun.SQL({
  url: DATABASE_URL,
  max: 10,
  connection: { search_path: `${schemaName},public` },
});
const readerDb = drizzle({
  client: readerClient,
  schema,
  casing: "snake_case",
});

const consistent = await checkConsistency(writerDb);
const { state, mutationId, bundleId } = await recoverState(
  writerDb,
  consistent,
);

const handle = startRuntime({
  initialState: state,
  initialMutationId: mutationId,
  initialBundleId: bundleId,
  bundleIntervalMs: 50,
  chain: CHAIN as Chain,
  rpcUrl: RPC_URL,
  account: deployerAccount,
  address: EXCHANGE_ADDRESS,
  rpId: process.env.BUN_PUBLIC_RP_ID || undefined,
  origin: process.env.BUN_PUBLIC_ORIGIN || undefined,
  db: writerDb,
});

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
} as const;

class Response extends globalThis.Response {
  constructor(body?: BodyInit | null, init?: ResponseInit) {
    super(body, {
      ...init,
      headers: { ...CORS_HEADERS, ...init?.headers },
    });
  }

  static override json(data: unknown, init?: ResponseInit) {
    return super.json(data, {
      ...init,
      headers: { ...CORS_HEADERS, ...init?.headers },
    });
  }
}

serve({
  idleTimeout: 0,
  routes: {
    "/api/*": {
      OPTIONS: () => new Response(null, { status: 204 }),
    },

    "/api/initialize": {
      POST: async (req) => {
        const body = (await req.json()) as Initialize & Signed;

        try {
          const result = await handle.execute({
            type: MutationType.Initialize,
            ...decodeSigned(body),
            mutation: {
              expiry: body.expiry,
              rootKeyType: body.rootKeyType,
              keyType: body.keyType,
              permissions: body.permissions,
              rootPublicKey: body.rootPublicKey,
              publicKey: body.publicKey,
            },
          });

          return Response.json({ id: result.id });
        } catch (err) {
          return Response.json({ error: String(err) }, { status: 400 });
        }
      },
    },

    "/api/authorize": {
      POST: async (req) => {
        const body = (await req.json()) as Authorize & Signed;

        try {
          const result = await handle.execute({
            type: MutationType.Authorize,
            ...decodeSigned(body),
            mutation: {
              expiry: body.expiry,
              keyType: body.keyType,
              permissions: body.permissions,
              publicKey: body.publicKey,
            },
          });

          return Response.json({ id: result.id });
        } catch (err) {
          return Response.json({ error: String(err) }, { status: 400 });
        }
      },
    },

    "/api/revoke": {
      POST: async (req) => {
        const body = (await req.json()) as Revoke & Signed;

        try {
          const result = await handle.execute({
            type: MutationType.Revoke,
            ...decodeSigned(body),
            mutation: { keyId: body.keyId },
          });

          return Response.json({ id: result.id });
        } catch (err) {
          return Response.json({ error: String(err) }, { status: 400 });
        }
      },
    },

    "/api/mint": {
      POST: async (req) => {
        const body = (await req.json()) as Deposit & Signed;

        try {
          const result = await handle.execute({
            type: MutationType.Deposit,
            ...decodeSigned(body),
            mutation: decodeDeposit(body),
          });

          return Response.json({ id: result.id });
        } catch (err) {
          return Response.json({ error: String(err) }, { status: 400 });
        }
      },
    },

    "/api/market-order": {
      POST: async (req) => {
        const body = (await req.json()) as MarketOrder & Signed;

        try {
          const result = await handle.execute({
            type: MutationType.MarketOrder,
            ...decodeSigned(body),
            mutation: decodeMarketOrder(body),
          });

          return Response.json({
            id: result.id,
            fills: result.resolution.fills.map((f) => ({
              quantity: f.quantity.toString(),
              price: f.price.toString(),
            })),
          });
        } catch (err) {
          return Response.json({ error: String(err) }, { status: 400 });
        }
      },
    },

    "/api/limit-order": {
      POST: async (req) => {
        const body = (await req.json()) as LimitOrder & Signed;

        try {
          const result = await handle.execute({
            type: MutationType.LimitOrder,
            ...decodeSigned(body),
            mutation: decodeLimitOrder(body),
          });

          return Response.json({ id: result.id });
        } catch (err) {
          return Response.json({ error: String(err) }, { status: 400 });
        }
      },
    },

    "/api/close-order": {
      POST: async (req) => {
        const body = (await req.json()) as CloseOrder & Signed;

        try {
          const result = await handle.execute({
            type: MutationType.CloseOrder,
            ...decodeSigned(body),
            mutation: body,
          });

          return Response.json({ id: result.id });
        } catch (err) {
          return Response.json({ error: String(err) }, { status: 400 });
        }
      },
    },

    "/api/add-instrument": {
      POST: async (req) => {
        const body = (await req.json()) as AddInstrument;

        try {
          const result = await handle.execute({
            type: MutationType.AddInstrument,
            mutation: body,
          });

          return Response.json({ id: result.id });
        } catch (err) {
          return Response.json({ error: String(err) }, { status: 400 });
        }
      },
    },

    "/api/events/blocks": {
      GET: () =>
        new Response(handle.stream("block"), {
          headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
          },
        }),
    },

    "/api/events/bundles": {
      GET: () =>
        new Response(handle.stream("bundle"), {
          headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
          },
        }),
    },

    "/api/events/mutations": {
      GET: () =>
        new Response(handle.stream("mutation"), {
          headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
          },
        }),
    },

    "/api/instruments": {
      GET: () => {
        const instruments = Object.entries(handle.state.instruments).map(
          ([id, inst]) => ({
            id: Number(id),
            base: inst.base,
            baseLotExp: inst.baseLotExp,
            quote: inst.quote,
            quoteLotExp: inst.quoteLotExp,
          }),
        );
        return Response.json({ instruments });
      },
    },

    "/api/orderbook": {
      GET: (req) => {
        const url = new URL(req.url);
        const instrumentId = Number(url.searchParams.get("instrumentId") ?? 0);
        const inst = handle.state.instruments[instrumentId] as
          | Instrument<bigint>
          | undefined;
        if (!inst)
          return Response.json(
            { error: "Instrument not found" },
            { status: 404 },
          );

        function formatLevels(ticks: Record<number, Tick<bigint>>) {
          const levels: { price: string; size: string; total: string }[] = [];
          for (const [priceKey, tick] of Object.entries(ticks)) {
            if (tick.remainingQuantity <= 0n) continue;
            levels.push({
              price: priceKey,
              size: tick.remainingQuantity.toString(),
              total: "0",
            });
          }
          return levels;
        }

        const bids = formatLevels(inst.bids);
        const asks = formatLevels(inst.asks);

        bids.sort((a, b) => Number(b.price) - Number(a.price));
        asks.sort((a, b) => Number(a.price) - Number(b.price));

        let bidTotal = 0n;
        for (const bid of bids) {
          bidTotal += BigInt(bid.size);
          bid.total = bidTotal.toString();
        }
        let askTotal = 0n;
        for (const ask of asks) {
          askTotal += BigInt(ask.size);
          ask.total = askTotal.toString();
        }

        const bestBidN = Number(bids[0]?.price ?? "0");
        const bestAskN = Number(asks[0]?.price ?? "0");
        const lastPrice =
          bestBidN && bestAskN
            ? String(Math.round((bestBidN + bestAskN) / 2))
            : String(bestBidN || bestAskN);
        const spread = bestAskN && bestBidN ? String(bestAskN - bestBidN) : "0";

        return Response.json({
          instrument: String(instrumentId),
          bids,
          asks,
          lastPrice,
          spread,
        });
      },
    },

    "/api/candles": {
      GET: async (req) => {
        const url = new URL(req.url);
        const instrumentId = Number(url.searchParams.get("instrumentId") ?? 0);
        const bucket = url.searchParams.get("bucket") ?? "5m";
        const before = url.searchParams.get("before")
          ? Number(url.searchParams.get("before"))
          : undefined;
        const count = Math.min(
          Number(url.searchParams.get("count") ?? 200),
          1000,
        );

        const bucketSec = BUCKET_SECONDS[bucket];
        if (!bucketSec)
          return Response.json({ error: "Invalid bucket" }, { status: 400 });

        const rows = await readerDb
          .select({
            fillId: schema.fills.id,
            price: schema.fills.price,
            quantity: schema.fills.quantity,
            timestamp: schema.blocks.timestamp,
          })
          .from(schema.fills)
          .innerJoin(
            schema.marketOrders,
            eq(schema.fills.marketOrderId, schema.marketOrders.id),
          )
          .innerJoin(
            schema.bundles,
            eq(schema.marketOrders.bundleId, schema.bundles.id),
          )
          .innerJoin(
            schema.blocks,
            eq(schema.bundles.blockNumber, schema.blocks.number),
          )
          .where(eq(schema.marketOrders.instrumentId, BigInt(instrumentId)))
          .orderBy(schema.fills.id);

        const candleMap = new Map<
          number,
          {
            open: string;
            high: string;
            low: string;
            close: string;
            volume: string;
          }
        >();

        for (const row of rows) {
          const ts = Number(row.timestamp);
          const bucketTime = Math.floor(ts / bucketSec) * bucketSec;
          const price = String(row.price!);
          const size = BigInt(String(row.quantity!));

          const existing = candleMap.get(bucketTime);
          if (existing) {
            if (Number(price) > Number(existing.high)) existing.high = price;
            if (Number(price) < Number(existing.low)) existing.low = price;
            existing.close = price;
            existing.volume = (BigInt(existing.volume) + size).toString();
          } else {
            candleMap.set(bucketTime, {
              open: price,
              high: price,
              low: price,
              close: price,
              volume: size.toString(),
            });
          }
        }

        let candles = Array.from(candleMap.entries())
          .map(([time, c]) => ({ time, ...c }))
          .sort((a, b) => a.time - b.time);

        if (before !== undefined) {
          candles = candles.filter((c) => c.time < before);
        }
        const hasMore = candles.length > count;
        candles = candles.slice(-count);

        return Response.json({ candles, hasMore });
      },
    },

    "/api/trades": {
      GET: async (req) => {
        const url = new URL(req.url);
        const instrumentId = Number(url.searchParams.get("instrumentId") ?? 0);
        const limit = Math.min(
          Number(url.searchParams.get("limit") ?? 50),
          200,
        );

        const rows = await readerDb
          .select({
            id: schema.fills.id,
            quantity: schema.fills.quantity,
            price: schema.fills.price,
            bidOrAsk: schema.marketOrders.bidOrAsk,
            timestamp: schema.blocks.timestamp,
          })
          .from(schema.fills)
          .innerJoin(
            schema.marketOrders,
            eq(schema.fills.marketOrderId, schema.marketOrders.id),
          )
          .innerJoin(
            schema.bundles,
            eq(schema.marketOrders.bundleId, schema.bundles.id),
          )
          .innerJoin(
            schema.blocks,
            eq(schema.bundles.blockNumber, schema.blocks.number),
          )
          .where(eq(schema.marketOrders.instrumentId, BigInt(instrumentId)))
          .orderBy(desc(schema.fills.id))
          .limit(limit);

        const trades = rows.map((r) => ({
          id: String(r.id),
          price: String(r.price!),
          size: String(r.quantity!),
          side: r.bidOrAsk === 0 ? ("buy" as const) : ("sell" as const),
          timestamp: Number(r.timestamp),
        }));

        return Response.json({ trades });
      },
    },

    "/api/orders": {
      GET: (req) => {
        const url = new URL(req.url);
        const account = url.searchParams.get("account");
        if (!account)
          return Response.json(
            { error: "account query parameter required" },
            { status: 400 },
          );

        const acc = handle.state.accounts[account as `0x${string}`];
        if (!acc) return Response.json({ orders: [] });

        const orders = acc.orders
          .map((o, i) => ({
            orderIndex: i,
            instrumentId: o.instrumentId,
            quantity: o.quantity.toString(),
            price: o.price.toString(),
            side: o.side,
          }))
          .filter((o) => o.quantity !== "0");

        return Response.json({ orders });
      },
    },

    "/api/balances": {
      GET: (req) => {
        const url = new URL(req.url);
        const account = url.searchParams.get("account");
        if (!account)
          return Response.json(
            { error: "account query parameter required" },
            { status: 400 },
          );

        const acc = handle.state.accounts[account as `0x${string}`];
        if (!acc)
          return Response.json({ error: "account not found" }, { status: 404 });

        const balances: Record<string, string> = {};
        for (const [asset, balance] of Object.entries(acc.balances)) {
          balances[asset] = balance.toString();
        }
        return Response.json({ account, balances });
      },
    },

    "/api/price": {
      GET: (req) => {
        const url = new URL(req.url);
        const instrumentId = url.searchParams.get("instrumentId");
        if (instrumentId === null)
          return Response.json(
            { error: "instrumentId query parameter required" },
            { status: 400 },
          );

        const instrument = handle.state.instruments[Number(instrumentId)];
        if (!instrument)
          return Response.json(
            { error: "instrument not found" },
            { status: 404 },
          );

        const bidPrices = Object.entries(instrument.bids)
          .filter(([, t]) => BigInt(t.remainingQuantity) > 0n)
          .map(([p]) => Number(p));
        const askPrices = Object.entries(instrument.asks)
          .filter(([, t]) => BigInt(t.remainingQuantity) > 0n)
          .map(([p]) => Number(p));
        const bestBid = bidPrices.length > 0 ? Math.max(...bidPrices) : null;
        const bestAsk = askPrices.length > 0 ? Math.min(...askPrices) : null;

        let price: number | null = null;
        if (bestBid !== null && bestAsk !== null) {
          price = Math.round((bestBid + bestAsk) / 2);
        } else if (bestBid !== null) {
          price = bestBid;
        } else if (bestAsk !== null) {
          price = bestAsk;
        }

        return Response.json({ instrumentId: Number(instrumentId), price });
      },
    },

    "/api/depth": {
      GET: (req) => {
        const url = new URL(req.url);
        const instrumentId = url.searchParams.get("instrumentId");
        if (instrumentId === null)
          return Response.json(
            { error: "instrumentId query parameter required" },
            { status: 400 },
          );

        const instrument = handle.state.instruments[Number(instrumentId)];
        if (!instrument)
          return Response.json(
            { error: "instrument not found" },
            { status: 404 },
          );

        const bidEntries = Object.entries(instrument.bids).filter(
          ([, t]) => BigInt(t.remainingQuantity) > 0n,
        );
        const askEntries = Object.entries(instrument.asks).filter(
          ([, t]) => BigInt(t.remainingQuantity) > 0n,
        );
        const bidPrices = bidEntries.map(([p]) => Number(p));
        const askPrices = askEntries.map(([p]) => Number(p));
        const bestBid = bidPrices.length > 0 ? Math.max(...bidPrices) : null;
        const bestAsk = askPrices.length > 0 ? Math.min(...askPrices) : null;

        const mid =
          bestBid !== null && bestAsk !== null
            ? Math.round((bestBid + bestAsk) / 2)
            : (bestBid ?? bestAsk);

        const BPS = [1, 5, 25] as const;
        const bids: Record<number, string> = {};
        const asks: Record<number, string> = {};

        if (mid !== null) {
          for (const bp of BPS) {
            let bidTotal = 0n;
            const bidThreshold = mid * (1 - bp / 10000);
            for (const [p, t] of bidEntries) {
              if (Number(p) >= bidThreshold) {
                bidTotal += BigInt(t.remainingQuantity);
              }
            }
            bids[bp] = bidTotal.toString();

            let askTotal = 0n;
            const askThreshold = mid * (1 + bp / 10000);
            for (const [p, t] of askEntries) {
              if (Number(p) <= askThreshold) {
                askTotal += BigInt(t.remainingQuantity);
              }
            }
            asks[bp] = askTotal.toString();
          }
        }

        return Response.json({
          instrumentId: Number(instrumentId),
          bids,
          asks,
        });
      },
    },

    "/api/state": {
      GET: () => {
        return Response.json(encodeState(handle.state));
      },
    },

    "/*": index,
  },

  development: process.env.NODE_ENV !== "production" && {
    hmr: true,
    console: true,
  },
});
