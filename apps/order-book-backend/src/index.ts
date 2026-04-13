import { serve } from "bun";
import { drizzle } from "drizzle-orm/bun-sql";
import type { Chain } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import * as schema from "./app-schema";
import { CHAIN, EXCHANGE_ADDRESS, RPC_URL } from "./constants";
import { dbPlugin, loadMaxIds, loadState } from "./db";
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
  type LimitOrder,
  type MarketOrder,
  MutationType,
  type Revoke,
  type Signed,
} from "./exchange";
import { CURRENCIES } from "./frontend/constants";
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
const client = new Bun.SQL({ url: DATABASE_URL, max: 1 });
const db = drizzle({ client, schema, casing: "snake_case" });
// @ts-ignore
await migrate(db, CHAIN.id, EXCHANGE_ADDRESS);

const { mutationId, bundleId } = await loadMaxIds(db);

const handle = startRuntime({
  initialState: await loadState(db),
  initialMutationId: mutationId,
  initialBundleId: bundleId,
  flushIntervalMs: 50,
  chain: CHAIN as Chain,
  rpcUrl: RPC_URL,
  account: deployerAccount,
  address: EXCHANGE_ADDRESS,
  rpId: process.env.BUN_PUBLIC_RP_ID || undefined,
  origin: process.env.BUN_PUBLIC_ORIGIN || undefined,
});

dbPlugin(handle, db);

const server = serve({
  idleTimeout: 0,
  routes: {
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
        if (!acc) {
          const balances: Record<string, string> = {};
          for (const currency of CURRENCIES) {
            balances[currency.address] = "0";
          }
          return Response.json({ account, balances });
        }

        const balances: Record<string, string> = {};
        for (const [asset, balance] of Object.entries(acc.balances)) {
          balances[asset] = balance.toString();
        }
        return Response.json({ account, balances });
      },
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

    "/api/state": {
      GET: () => Response.json(encodeState(handle.state)),
    },

    "/*": index,
  },

  development: process.env.NODE_ENV !== "production" && {
    hmr: true,
    console: true,
  },
});

console.log(`Server running at ${server.url}`);
