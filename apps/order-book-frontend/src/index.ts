import { serve } from "bun";
import { drizzle } from "drizzle-orm/bun-sql";
import { migrate } from "drizzle-orm/bun-sql/migrator";
import type { Address, Chain } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  CHAIN,
  CURRENCIES,
  EXAMPLE_STATE,
  EXCHANGE_ADDRESS,
  RPC_URL,
} from "./constants";
import { dbPlugin } from "./db";
import {
  type CloseOrder,
  type Deposit,
  decodeDeposit,
  decodeLimitOrder,
  decodeMarketOrder,
  decodeSigned,
  type LimitOrder,
  type MarketOrder,
  MutationType,
  type Signed,
} from "./exchange";
import index from "./index.html";
import { startRuntime } from "./runtime";
import * as schema from "./schema";

// @ts-expect-error
if (!process.env.DEPLOYER_PRIVATE_KEY) {
  throw new Error("DEPLOYER_PRIVATE_KEY env var is required");
}
// @ts-expect-error
const DEPLOYER_PRIVATE_KEY = process.env.DEPLOYER_PRIVATE_KEY as `0x${string}`;
const deployerAccount = privateKeyToAccount(DEPLOYER_PRIVATE_KEY);

const handle = startRuntime({
  initialState: structuredClone(EXAMPLE_STATE),
  flushIntervalMs: 50,
  chain: CHAIN as Chain,
  rpcUrl: RPC_URL,
  account: deployerAccount,
  address: EXCHANGE_ADDRESS,
});

// @ts-expect-error
if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL env var is required");
}

// @ts-expect-error
const db = drizzle(process.env.DATABASE_URL!, { schema, casing: "snake_case" });
await migrate(db, { migrationsFolder: "./drizzle" });
dbPlugin(handle, db);

const server = serve({
  idleTimeout: 0,
  routes: {
    "/api/balances": {
      GET: (req) => {
        const url = new URL(req.url);
        const account = url.searchParams.get("account") as Address | null;
        if (!account)
          return Response.json(
            { error: "account query parameter required" },
            { status: 400 },
          );

        const acc = handle.state.accounts[account];
        if (!acc) {
          const balances: Record<string, string> = {};
          for (const currency of CURRENCIES) {
            balances[currency.address] = "0";
          }

          return Response.json({
            account,
            nonce: "0",
            balances,
          });
        }

        const balances: Record<string, string> = {};
        for (const [asset, balance] of Object.entries(acc.balances)) {
          balances[asset] = balance.toString();
        }
        return Response.json({
          account,
          nonce: acc.nonce.toString(),
          balances,
        });
      },
    },

    "/api/instrument-price": {
      GET: (req) => {
        const url = new URL(req.url);
        const instrumentIdParam = url.searchParams.get("instrumentId");

        if (instrumentIdParam === null)
          return Response.json(
            { error: "instrumentId query parameter required" },
            { status: 400 },
          );

        const instrumentId = Number(instrumentIdParam);
        const instrument = handle.state.instruments[instrumentId];
        if (!instrument)
          return Response.json(
            { error: "Invalid instrument" },
            { status: 404 },
          );

        const bidPrices = Object.keys(instrument.bids)
          .map(Number)
          .sort((a, b) => b - a);
        const askPrices = Object.keys(instrument.asks)
          .map(Number)
          .sort((a, b) => a - b);

        return Response.json({
          instrumentId,
          base: instrument.base,
          quote: instrument.quote,
          bestBid: bidPrices[0] ?? null,
          bestAsk: askPrices[0] ?? null,
          bids: bidPrices.flatMap((price) => {
            const tick = instrument.bids[price];
            if (!tick) return [];
            return {
              price,
              quantity: tick.quantity.toString(),
              remainingQuantity: tick.remainingQuantity.toString(),
              volume: tick.volume,
            };
          }),
          asks: askPrices.flatMap((price) => {
            const tick = instrument.asks[price];
            if (!tick) return [];
            return {
              price,
              quantity: tick.quantity.toString(),
              remainingQuantity: tick.remainingQuantity.toString(),
              volume: tick.volume,
            };
          }),
        });
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
              price: Number(f.price),
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

    "/*": index,
  },

  development: process.env.NODE_ENV !== "production" && {
    hmr: true,
    console: true,
  },
});

console.log(`Server running at ${server.url}`);
