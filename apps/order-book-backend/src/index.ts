import { serve } from "bun";
import { and, asc, desc, eq, inArray, ne } from "drizzle-orm";
import type { BunSQLDatabase } from "drizzle-orm/bun-sql";
import { drizzle } from "drizzle-orm/bun-sql";
import type { Chain, Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import * as schema from "./app-schema";
import { CHAIN, EXCHANGE_ADDRESS, RPC_URLS } from "./constants";
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
  type LimitOrder,
  type MarketOrder,
  MutationType,
  type Revoke,
  type Signed,
} from "./exchange";
import index from "./frontend/index.html";
import { migrate } from "./migrate";
import { startRuntime } from "./runtime";

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

type DB = BunSQLDatabase<typeof schema>;

type ApiMutation = {
  id: number;
  bundleId: number | null;
  bundlePosition: number | null;
  blockNumber: string | null;
  status: (typeof schema.mutationStatusEnum.enumValues)[number];
  account: Hex;
  accountSerial: number | null;
  keyIndex: string | null;
  nonce: string | null;
  deadline: string;
  type: (typeof schema.mutationEnum.enumValues)[number];
  pendingAt: Date;
  acceptedAt: Date | null;
  proposedAt: Date | null;
  votedAt: Date | null;
  finalizedAt: Date | null;
  verifiedAt: Date | null;
  transactionHash: string | null;
  payload: unknown;
};

async function loadMutationsByIds(
  db: DB,
  ids: number[],
): Promise<ApiMutation[]> {
  if (ids.length === 0) return [];

  const centrals = await db
    .select({
      id: schema.mutations.id,
      bundleId: schema.mutations.bundleId,
      bundlePosition: schema.mutations.bundlePosition,
      blockNumber: schema.mutations.blockNumber,
      status: schema.mutations.status,
      account: schema.mutations.account,
      accountSerial: schema.accounts.serial,
      keyIndex: schema.mutations.keyIndex,
      nonce: schema.mutations.nonce,
      deadline: schema.mutations.deadline,
      type: schema.mutations.type,
      pendingAt: schema.mutations.pendingAt,
      acceptedAt: schema.mutations.acceptedAt,
      proposedAt: schema.mutations.proposedAt,
      votedAt: schema.mutations.votedAt,
      finalizedAt: schema.mutations.finalizedAt,
      verifiedAt: schema.mutations.verifiedAt,
      transactionHash: schema.bundles.transactionHash,
    })
    .from(schema.mutations)
    .leftJoin(schema.bundles, eq(schema.mutations.bundleId, schema.bundles.id))
    .leftJoin(schema.accounts, eq(schema.mutations.account, schema.accounts.id))
    .where(inArray(schema.mutations.id, ids))
    .orderBy(
      asc(schema.mutations.bundleId),
      asc(schema.mutations.bundlePosition),
    );

  const [
    initRows,
    authRows,
    revokeRows,
    closeRows,
    limitRows,
    marketRows,
    addInstRows,
    depRows,
    wdRows,
    fillRows,
  ] = await Promise.all([
    db
      .select()
      .from(schema.initializes)
      .where(inArray(schema.initializes.id, ids)),
    db
      .select()
      .from(schema.authorizes)
      .where(inArray(schema.authorizes.id, ids)),
    db.select().from(schema.revokes).where(inArray(schema.revokes.id, ids)),
    db
      .select()
      .from(schema.closeOrders)
      .where(inArray(schema.closeOrders.id, ids)),
    db
      .select()
      .from(schema.limitOrders)
      .where(inArray(schema.limitOrders.id, ids)),
    db
      .select()
      .from(schema.marketOrders)
      .where(inArray(schema.marketOrders.id, ids)),
    db
      .select()
      .from(schema.addInstruments)
      .where(inArray(schema.addInstruments.id, ids)),
    db.select().from(schema.deposits).where(inArray(schema.deposits.id, ids)),
    db
      .select()
      .from(schema.withdrawals)
      .where(inArray(schema.withdrawals.id, ids)),
    db
      .select()
      .from(schema.fills)
      .where(inArray(schema.fills.marketOrderId, ids))
      .orderBy(asc(schema.fills.marketOrderId), asc(schema.fills.fillIndex)),
  ]);

  const payloadById = new Map<number, unknown>();
  for (const r of initRows) payloadById.set(r.id, r);
  for (const r of authRows) payloadById.set(r.id, r);
  for (const r of revokeRows) {
    payloadById.set(r.id, { ...r, revokedKeyId: r.revokedKeyId.toString() });
  }
  for (const r of closeRows) {
    payloadById.set(r.id, { ...r, orderId: r.orderId.toString() });
  }
  for (const r of limitRows) {
    payloadById.set(r.id, {
      ...r,
      instrumentId: r.instrumentId.toString(),
      price: r.price.toString(),
    });
  }
  const fillsByMarket = new Map<number, typeof fillRows>();
  for (const f of fillRows) {
    const list = fillsByMarket.get(f.marketOrderId) ?? [];
    list.push(f);
    fillsByMarket.set(f.marketOrderId, list);
  }
  for (const r of marketRows) {
    payloadById.set(r.id, {
      ...r,
      instrumentId: r.instrumentId.toString(),
      fills: (fillsByMarket.get(r.id) ?? []).map((f) => ({
        quantity: f.quantity.toString(),
        price: f.price.toString(),
      })),
    });
  }
  for (const r of addInstRows) {
    payloadById.set(r.id, { ...r, instrumentId: r.instrumentId.toString() });
  }
  for (const r of depRows) payloadById.set(r.id, r);
  for (const r of wdRows) payloadById.set(r.id, r);

  return centrals.map((c) => ({
    id: c.id,
    bundleId: c.bundleId,
    bundlePosition: c.bundlePosition,
    blockNumber: c.blockNumber,
    status: c.status,
    account: c.account as Hex,
    accountSerial: c.accountSerial,
    keyIndex: c.keyIndex != null ? c.keyIndex.toString() : null,
    nonce: c.nonce,
    deadline: c.deadline,
    type: c.type,
    pendingAt: c.pendingAt,
    acceptedAt: c.acceptedAt,
    proposedAt: c.proposedAt,
    votedAt: c.votedAt,
    finalizedAt: c.finalizedAt,
    verifiedAt: c.verifiedAt,
    transactionHash: c.transactionHash,
    payload: payloadById.get(c.id) ?? null,
  }));
}

if (!process.env.DEPLOYER_PRIVATE_KEY) {
  throw new Error("DEPLOYER_PRIVATE_KEY env var is required");
}
const DEPLOYER_PRIVATE_KEY = process.env.DEPLOYER_PRIVATE_KEY as `0x${string}`;
const deployerAccount = privateKeyToAccount(DEPLOYER_PRIVATE_KEY);

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL env var is required");
}

const DATABASE_URL: string = process.env.DATABASE_URL;

const migrationClient = new Bun.SQL({ url: DATABASE_URL, max: 1 });
const migrationDb = drizzle({
  client: migrationClient,
  schema,
  casing: "snake_case",
});

// @ts-expect-error migrate's BunSQLDatabase type doesn't carry schema
const schemaName = await migrate(migrationDb, CHAIN.id, EXCHANGE_ADDRESS);

const writerClient = new Bun.SQL({
  url: DATABASE_URL,
  max: 5,
  connection: { search_path: `${schemaName},public` },
});
const writerDb = drizzle({
  client: writerClient,
  schema,
  casing: "snake_case",
});

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
const { state, mutationId } = await recoverState(writerDb, consistent);

const handle = startRuntime({
  initialState: state,
  initialMutationId: mutationId,
  chain: CHAIN as Chain,
  rpcUrls: RPC_URLS,
  account: deployerAccount,
  address: EXCHANGE_ADDRESS,
  rpId: process.env.BUN_PUBLIC_RP_ID || undefined,
  origin: process.env.BUN_PUBLIC_ORIGIN || undefined,
  db: writerDb,
});

const TPS_WINDOW_MS = 10_000;
const acceptedMutationTimestamps: number[] = [];
handle.on("mutation", (m) => {
  if (m.status !== "accepted") return;
  acceptedMutationTimestamps.push(Date.now());
});

serve({
  idleTimeout: 0,
  routes: {
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
        const body = (await req.json()) as AddInstrument & Signed;

        try {
          const result = await handle.execute({
            type: MutationType.AddInstrument,
            ...decodeSigned(body),
            mutation: body,
          });

          return Response.json({ id: result.id });
        } catch (err) {
          return Response.json({ error: String(err) }, { status: 400 });
        }
      },
    },

    "/api/tps": {
      GET: () => {
        const cutoff = Date.now() - TPS_WINDOW_MS;
        let drop = 0;
        while (
          drop < acceptedMutationTimestamps.length &&
          acceptedMutationTimestamps[drop]! < cutoff
        ) {
          drop++;
        }
        if (drop > 0) acceptedMutationTimestamps.splice(0, drop);
        return Response.json(
          acceptedMutationTimestamps.length / (TPS_WINDOW_MS / 1000),
        );
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

    "/api/blocks/:number": {
      GET: async (req) => {
        const number = req.params.number;
        if (!/^\d+$/.test(number)) {
          return Response.json(
            { error: "Invalid block number" },
            { status: 400 },
          );
        }

        const [row] = await readerDb
          .select()
          .from(schema.blocks)
          .where(eq(schema.blocks.number, number))
          .limit(1);

        if (!row) {
          return Response.json({ error: "Block not found" }, { status: 404 });
        }

        return Response.json({
          number: row.number,
          hash: row.hash,
          timestamp: row.timestamp,
        });
      },
    },

    "/api/mutations": {
      GET: async (req) => {
        const url = new URL(req.url);
        const block = url.searchParams.get("block");
        if (block === null || !/^\d+$/.test(block)) {
          return Response.json(
            { error: "block query parameter required (integer)" },
            { status: 400 },
          );
        }

        const idRows = await readerDb
          .select({ id: schema.mutations.id })
          .from(schema.mutations)
          .where(eq(schema.mutations.blockNumber, block));
        const mutations = await loadMutationsByIds(
          readerDb,
          idRows.map((r) => r.id),
        );
        return Response.json(mutations);
      },
    },

    "/api/mutation": {
      GET: async (req) => {
        const url = new URL(req.url);
        const idParam = url.searchParams.get("id");
        const account = url.searchParams.get("account");
        const nonce = url.searchParams.get("nonce");

        let id: number | null = null;
        if (idParam !== null) {
          if (!/^\d+$/.test(idParam)) {
            return Response.json({ error: "Invalid id" }, { status: 400 });
          }
          id = Number(idParam);
        } else if (account !== null && nonce !== null) {
          if (!/^0x[0-9a-fA-F]{64}$/.test(account) || !/^\d+$/.test(nonce)) {
            return Response.json(
              { error: "Invalid account or nonce" },
              { status: 400 },
            );
          }
          const [row] = await readerDb
            .select({ id: schema.mutations.id })
            .from(schema.mutations)
            .where(
              and(
                eq(schema.mutations.account, account),
                eq(schema.mutations.nonce, nonce),
              ),
            )
            .limit(1);
          if (!row) {
            return Response.json(
              { error: "Mutation not found" },
              { status: 404 },
            );
          }
          id = row.id;
        } else {
          return Response.json(
            { error: "Query with id, or account and nonce" },
            { status: 400 },
          );
        }

        const [mutation] = await loadMutationsByIds(readerDb, [id]);
        if (!mutation) {
          return Response.json(
            { error: "Mutation not found" },
            { status: 404 },
          );
        }
        return Response.json(mutation);
      },
    },

    "/api/account/:id": {
      GET: async (req) => {
        const idParam = req.params.id;

        let address: Hex;
        let serial: number;
        if (/^\d+$/.test(idParam)) {
          const [row] = await readerDb
            .select({ id: schema.accounts.id, serial: schema.accounts.serial })
            .from(schema.accounts)
            .where(eq(schema.accounts.serial, Number(idParam)))
            .limit(1);
          if (!row)
            return Response.json(
              { error: "account not found" },
              { status: 404 },
            );
          address = row.id as Hex;
          serial = row.serial;
        } else {
          address = idParam as Hex;
          const [row] = await readerDb
            .select({ serial: schema.accounts.serial })
            .from(schema.accounts)
            .where(eq(schema.accounts.id, address))
            .limit(1);
          if (!row)
            return Response.json(
              { error: "account not found" },
              { status: 404 },
            );
          serial = row.serial;
        }

        const acc = handle.state.accounts[address];
        if (!acc)
          return Response.json({ error: "account not found" }, { status: 404 });

        const idRows = await readerDb
          .select({ id: schema.mutations.id })
          .from(schema.mutations)
          .where(
            and(
              eq(schema.mutations.account, address),
              ne(schema.mutations.status, "pending"),
            ),
          )
          .orderBy(desc(schema.mutations.id))
          .limit(50);
        const mutations = (
          await loadMutationsByIds(readerDb, idRows.map((r) => r.id))
        ).reverse();

        const nonces: Record<string, string> = {};
        for (const [k, v] of Object.entries(acc.nonces)) {
          nonces[k] = v.toString();
        }

        const balances: Record<string, string> = {};
        for (const [asset, amount] of Object.entries(acc.balances)) {
          balances[asset] = amount.toString();
        }

        return Response.json({
          address,
          serial,
          keys: acc.keys.map((k) => ({
            keyType: k.keyType,
            permissions: k.permissions,
            expiry: k.expiry,
            publicKey: k.publicKey,
          })),
          nonces,
          orders: acc.orders.map((o) => ({
            quantity: o.quantity.toString(),
            instrumentId: o.instrumentId,
            price: o.price.toString(),
            tickVolume: o.tickVolume,
            side: o.side,
          })),
          balances,
          mutations,
        });
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

        const spread =
          bestBid !== null && bestAsk !== null ? bestAsk - bestBid : null;

        return Response.json({
          instrumentId: Number(instrumentId),
          price,
          bestBid,
          bestAsk,
          spread,
        });
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
