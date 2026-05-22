import { serve } from "bun";
import { drizzle } from "drizzle-orm/bun-sql/postgres";
import { createFFCA } from "ffca";
import { EXCHANGE_ABI } from "order-book-sdk";
import type { Address, Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import index from "../frontend/index.html";
import {
  baseMutations,
  createKnownPriceLevels,
  normalizeSignatureForContract,
  ORDER_BOOK_SEQUENCE,
  type OrderBookMutationName,
  type OrderBookSignature,
  type SubmittedOrderBookMutation,
} from "./app";
import { applyDeploymentSchema } from "./app-schema";
import { CHAIN, EXCHANGE_ADDRESS, RPC_URLS } from "./constants";
import {
  loadBlock,
  loadMutationByAccountNonce,
  loadMutationById,
  loadMutationsByBlock,
  type QueryDatabase,
} from "./db-queries";
import { EXCHANGE_STORAGE_LAYOUT } from "./storage-layout";

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
const knownPriceLevels = createKnownPriceLevels();

const app = await createFFCA({
  address: EXCHANGE_ADDRESS,
  domain: { name: "Exchange", version: "1" },
  abi: EXCHANGE_ABI,
  storageLayout: EXCHANGE_STORAGE_LAYOUT,
  account,
  chainId: CHAIN.id,
  rpcUrl: RPC_URLS,
  database,
  sequence: ORDER_BOOK_SEQUENCE,
  mutations: baseMutations(knownPriceLevels),
});
applyDeploymentSchema(CHAIN.id, EXCHANGE_ADDRESS);

const readerDb: QueryDatabase = drizzle({
  client: readerConnection,
});

type MutationStatus =
  | "submitted"
  | "accepted"
  | "included"
  | "safe"
  | "finalized";

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
  args: Record<string, unknown>;
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
    event.status === "rejected"
      ? "submitted"
      : (event.status as MutationStatus);
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
      signature: normalizeSignatureForContract(signature),
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
    console.error(error);
    return json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 400 },
    );
  }
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
      GET: async (req) => {
        const number = req.params.number;
        if (!/^\d+$/.test(number)) {
          return json({ error: "Invalid block number" }, { status: 400 });
        }
        const block = await loadBlock(readerDb, number);
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
        const mutations = await loadMutationsByBlock(readerDb, block);
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
          mutation = await loadMutationById(readerDb, Number(idParam));
        } else if (accountParam !== null && nonceParam !== null) {
          if (
            !/^0x[0-9a-fA-F]{64}$/.test(accountParam) ||
            !/^\d+$/.test(nonceParam)
          ) {
            return json({ error: "Invalid account or nonce" }, { status: 400 });
          }
          mutation = await loadMutationByAccountNonce(
            readerDb,
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
      GET: () =>
        notImplemented(
          "TODO: serve account orders from ffca storage/read model.",
        ),
    },
    "/api/account/:id/exists": {
      GET: () =>
        notImplemented(
          "TODO: serve account existence from ffca storage/read model.",
        ),
    },
    "/api/account/:id": {
      GET: () =>
        notImplemented(
          "TODO: serve account state from ffca storage/read model.",
        ),
    },
    "/api/balances": {
      GET: () =>
        notImplemented("TODO: serve balances from ffca storage/read model."),
    },
    "/api/price": {
      GET: () =>
        notImplemented("TODO: serve price from ffca storage/read model."),
    },
    "/api/depth": {
      GET: () =>
        notImplemented("TODO: serve depth from ffca storage/read model."),
    },
    "/api/ticks": {
      POST: () =>
        notImplemented("TODO: serve ticks from ffca storage/read model."),
    },
    "/api/estimate-market-order": {
      GET: () =>
        notImplemented(
          "TODO: serve market estimates from ffca storage/read model.",
        ),
    },
    "/api/estimate-fill-to-price": {
      GET: () =>
        notImplemented(
          "TODO: serve fill estimates from ffca storage/read model.",
        ),
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
