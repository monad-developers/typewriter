import { serve } from "bun";
import { drizzle } from "drizzle-orm/bun-sql";
import { CURRENCIES } from "order-book-frontend/src/constants";
import index from "order-book-frontend/src/index.html";
import type { Chain } from "viem";
import {
  generatePrivateKey,
  privateKeyToAccount,
  signTypedData,
} from "viem/accounts";
import * as schema from "./app-schema";
import { CHAIN, EIP712_TYPES, EXCHANGE_ADDRESS, RPC_URL } from "./constants";
import { dbPlugin, loadMaxIds, loadState } from "./db";
import {
  type Authorize,
  type CloseOrder,
  type Deposit,
  decodeDeposit,
  decodeLimitOrder,
  decodeMarketOrder,
  decodeSigned,
  type Initialize,
  type LimitOrder,
  type MarketOrder,
  MutationType,
  type Revoke,
  type Signed,
} from "./exchange";
import { migrate } from "./migrate";
import { startRuntime } from "./runtime";

// @ts-expect-error
if (!process.env.DEPLOYER_PRIVATE_KEY) {
  throw new Error("DEPLOYER_PRIVATE_KEY env var is required");
}
// @ts-expect-error
const DEPLOYER_PRIVATE_KEY = process.env.DEPLOYER_PRIVATE_KEY as `0x${string}`;
const deployerAccount = privateKeyToAccount(DEPLOYER_PRIVATE_KEY);

// @ts-expect-error
if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL env var is required");
}
// @ts-expect-error
const DATABASE_URL: string = process.env.DATABASE_URL;
const db = drizzle(DATABASE_URL, { schema, casing: "snake_case" });
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
  // @ts-expect-error
  rpId: process.env.BUN_PUBLIC_RP_ID || undefined,
  // @ts-expect-error
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

          return Response.json({
            account,
            nonces: {},
            balances,
          });
        }

        const balances: Record<string, string> = {};
        for (const [asset, balance] of Object.entries(acc.balances)) {
          balances[asset] = balance.toString();
        }
        const nonces: Record<string, string> = {};
        for (const [k, v] of Object.entries(acc.nonces)) {
          nonces[k] = v.toString();
        }
        return Response.json({
          account,
          nonces,
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
        if (!instrument) {
          return Response.json(
            { error: "Invalid instrument" },
            { status: 404 },
          );
        }

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

    "/api/sign-in": {
      POST: async () => {
        try {
          const privateKey = generatePrivateKey();
          const wallet = privateKeyToAccount(privateKey);
          const accountId =
            `0x000000000000000000000000${wallet.address.slice(2).toLowerCase()}` as `0x${string}`;
          const FAR_DEADLINE = BigInt(
            "0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
          );
          const domain = {
            name: "Exchange" as const,
            version: "1" as const,
            chainId: CHAIN.id,
            verifyingContract: EXCHANGE_ADDRESS,
          };

          const initSignature = await signTypedData({
            privateKey,
            domain,
            types: EIP712_TYPES,
            primaryType: "Initialize",
            message: {
              account: accountId,
              expiry: 0,
              rootKeyType: 2,
              keyType: 2,
              permissions: 0xff,
              rootPublicKey: accountId,
              publicKey: accountId,
            },
          });

          await handle.execute({
            type: MutationType.Initialize,
            account: accountId,
            keyId: 0,
            nonce: 0n,
            deadline: FAR_DEADLINE,
            rawSignature: initSignature,
            mutation: {
              expiry: 0,
              rootKeyType: 2,
              keyType: 2,
              permissions: 0xff,
              rootPublicKey: accountId,
              publicKey: accountId,
            },
          });

          let nonce = 1n;
          for (const currency of CURRENCIES) {
            const amount = 10000n * 10n ** BigInt(currency.decimals);

            const depositSignature = await signTypedData({
              privateKey,
              domain,
              types: EIP712_TYPES,
              primaryType: "Deposit",
              message: {
                asset: currency.address,
                amount,
                nonce,
                deadline: FAR_DEADLINE,
              },
            });

            await handle.execute({
              type: MutationType.Deposit,
              account: accountId,
              keyId: 1,
              nonce,
              deadline: FAR_DEADLINE,
              rawSignature: depositSignature,
              mutation: { asset: currency.address, amount },
            });

            nonce++;
          }

          return Response.json({
            address: wallet.address,
            accountId,
            privateKey,
          });
        } catch (err) {
          return Response.json({ error: String(err) }, { status: 400 });
        }
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
