import { serve } from "bun";
import { createFFCA } from "ffca";
import { EXCHANGE_ABI } from "order-book-sdk";
import type { Address, Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
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
import { createState } from "./exchange";

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
const state = createState();

const app = createFFCA({
  address: EXCHANGE_ADDRESS,
  domain: { name: "Exchange", version: "1" },
  abi: EXCHANGE_ABI,
  account,
  chainId: CHAIN.id,
  rpcUrl: RPC_URLS,
  database,
  state: { initial: state, schema: APP_SCHEMA },
  signature: { params: ORDER_BOOK_SIGNATURE_PARAMS },
  sequence: ORDER_BOOK_SEQUENCE,
  mutations: persistedMutations(state),
});

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
      signature: normalizeSignatureForContract(state, signature),
    });
    return json({ id: result.id, status: result.status });
  } catch (error) {
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
    "/api/state": {
      GET: () => json(app.state),
    },
    "/health": {
      GET: () => Response.json({ ok: true }),
    },
  },
});
