import { serve } from "bun";
import type { Side } from "order-book-sdk";
import superjson from "superjson";
import type { Hex } from "viem";
import index from "../frontend/index.html";
import { app, dev } from "./app";
import {
  accountBalances,
  accountCredentials,
  accountExists,
  accountOrders,
  depth,
  estimateFillToPrice,
  estimateMarketOrder,
  price,
  tickAt,
} from "./book";
import {
  selectBlock,
  selectMutationByExecutionIndex,
  selectMutationsByAccount,
  selectMutationsByBlock,
  selectRecentMutationCount,
} from "./db-queries";

const ACCOUNT_MUTATION_HISTORY_LIMIT = 50;
const TPS_WINDOW_MS = 10000;
const LIVE_BATCH_COUNT = 8;
const LIVE_BLOCK_COUNT = 8;

type LiveBatch = { id: number; position: number; mutationCount: number };

// The mutation tables have no status column; derive it from `block_number`
// and the latest finalized block. Until a block finalizes after startup,
// included mutations read as "included".
let finalizedBlockNumber = -1n;
let acceptedBatches: LiveBatch[] = [];
let includedBlocks: {
  number: bigint;
  hash: Hex;
  timestamp: bigint;
  batches: LiveBatch[];
}[] = [];

function liveBatch(batch: {
  id: number;
  position: number;
  mutations: unknown[];
}): LiveBatch {
  return {
    id: batch.id,
    position: batch.position,
    mutationCount: batch.mutations.length,
  };
}

app.on("batch", (batch) => {
  if (batch.status !== "accepted") return;
  acceptedBatches = [...acceptedBatches, liveBatch(batch)].slice(
    -LIVE_BATCH_COUNT,
  );
});

app.on("block", (block) => {
  if (block.status === "finalized") {
    if (block.number > finalizedBlockNumber) {
      finalizedBlockNumber = block.number;
    }
    return;
  }
  acceptedBatches = [];
  includedBlocks = [
    {
      number: block.number,
      hash: block.hash,
      timestamp: block.timestamp,
      batches: block.batches.map(liveBatch),
    },
    ...includedBlocks,
  ].slice(0, LIVE_BLOCK_COUNT);
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

function json(value: unknown, init?: ResponseInit): Response {
  return new Response(superjson.stringify(value), {
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers },
  });
}

function badRequest(error: string): Response {
  return json({ error }, { status: 400 });
}

function intParam(value: string | null): bigint | undefined {
  return value !== null && /^\d+$/.test(value) ? BigInt(value) : undefined;
}

function sideParam(value: string | null): Side | undefined {
  return value === "buy" || value === "sell" ? value : undefined;
}

function isAccountID(value: string | null): value is Hex {
  return value !== null && /^0x[0-9a-fA-F]{64}$/.test(value);
}

const server = serve({
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
          return badRequest("Bad Request");
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
        const count = await selectRecentMutationCount(TPS_WINDOW_MS);
        return json(count / (TPS_WINDOW_MS / 1000));
      },
    },
    "/api/live-blocks": {
      GET: () => json({ acceptedBatches, includedBlocks }),
    },
    "/api/blocks/:number": {
      GET: async (req) => {
        const number = intParam(req.params.number);
        if (number === undefined) return badRequest("Invalid block number");
        const block = await selectBlock(number);
        if (block === null) {
          return json({ error: "Block not found" }, { status: 404 });
        }
        return json(block);
      },
    },
    "/api/mutations": {
      GET: async (req) => {
        const block = intParam(new URL(req.url).searchParams.get("block"));
        if (block === undefined) {
          return badRequest("block query parameter required (integer)");
        }
        const mutations = await selectMutationsByBlock(block);
        return json(mutations.map(withStatus));
      },
    },
    "/api/mutation": {
      GET: async (req) => {
        const executionIndex = intParam(
          new URL(req.url).searchParams.get("executionIndex"),
        );
        if (executionIndex === undefined) {
          return badRequest(
            "executionIndex query parameter required (integer)",
          );
        }
        const mutation = await selectMutationByExecutionIndex(executionIndex);
        if (mutation === null) {
          return json({ error: "Mutation not found" }, { status: 404 });
        }
        return json(withStatus(mutation));
      },
    },
    "/api/account/:id/orders": {
      GET: (req) => {
        const account = req.params.id;
        if (!isAccountID(account)) return badRequest("Invalid account ID");
        if (!accountExists(account)) {
          return json({ error: "account not found" }, { status: 404 });
        }
        const instrumentId = intParam(
          new URL(req.url).searchParams.get("instrumentId"),
        );
        return json({ orders: accountOrders(account, instrumentId) });
      },
    },
    "/api/account/:id/exists": {
      GET: (req) => {
        const account = req.params.id;
        return json({ exists: isAccountID(account) && accountExists(account) });
      },
    },
    "/api/account/:id": {
      GET: async (req) => {
        const account = req.params.id;
        if (!isAccountID(account)) return badRequest("Invalid account ID");
        if (!accountExists(account)) {
          return json({ error: "account not found" }, { status: 404 });
        }
        const mutations = await selectMutationsByAccount(
          account,
          ACCOUNT_MUTATION_HISTORY_LIMIT,
        );
        return json({
          address: account,
          credentials: accountCredentials(account),
          balances: accountBalances(account),
          mutations: mutations.map(withStatus),
        });
      },
    },
    "/api/balances": {
      GET: (req) => {
        const account = new URL(req.url).searchParams.get("account");
        if (!isAccountID(account)) {
          return badRequest("account query parameter required");
        }
        if (!accountExists(account)) {
          return json({ error: "account not found" }, { status: 404 });
        }
        return json({ account, balances: accountBalances(account) });
      },
    },
    "/api/price": {
      GET: (req) => {
        const instrumentId = intParam(
          new URL(req.url).searchParams.get("instrumentId"),
        );
        if (instrumentId === undefined) {
          return badRequest("instrumentId query parameter required");
        }
        return json(price(instrumentId));
      },
    },
    "/api/depth": {
      GET: (req) => {
        const instrumentId = intParam(
          new URL(req.url).searchParams.get("instrumentId"),
        );
        if (instrumentId === undefined) {
          return badRequest("instrumentId query parameter required");
        }
        return json(depth(instrumentId));
      },
    },
    "/api/ticks": {
      POST: async (req) => {
        const body = superjson.parse(await req.text()) as {
          instrumentId?: number | bigint;
          queries?: { side: Side; priceQ32: bigint }[];
        };
        const { instrumentId, queries } = body;
        if (
          (typeof instrumentId !== "number" &&
            typeof instrumentId !== "bigint") ||
          !Array.isArray(queries)
        ) {
          return badRequest("instrumentId and queries required");
        }
        return json({
          ticks: queries.map((query) =>
            tickAt(BigInt(instrumentId), query.side, BigInt(query.priceQ32)),
          ),
        });
      },
    },
    "/api/estimate-market-order": {
      GET: (req) => {
        const params = new URL(req.url).searchParams;
        const instrumentId = intParam(params.get("instrumentId"));
        const side = sideParam(params.get("side"));
        const quantity = intParam(params.get("quantity"));
        if (
          instrumentId === undefined ||
          side === undefined ||
          quantity === undefined
        ) {
          return badRequest("instrumentId, side, and quantity required");
        }
        const estimate = estimateMarketOrder(instrumentId, side, quantity);
        if (estimate === null) return badRequest("insufficient liquidity");
        return json(estimate);
      },
    },
    "/api/estimate-fill-to-price": {
      GET: (req) => {
        const params = new URL(req.url).searchParams;
        const instrumentId = intParam(params.get("instrumentId"));
        const side = sideParam(params.get("side"));
        const priceQ32 = intParam(params.get("priceQ32"));
        if (
          instrumentId === undefined ||
          side === undefined ||
          priceQ32 === undefined
        ) {
          return badRequest("instrumentId, side, and priceQ32 required");
        }
        return json(estimateFillToPrice(instrumentId, side, priceQ32));
      },
    },
    "/*": index,
  },
  development: dev && { hmr: true, console: true },
});

console.log(`order-book listening on ${server.url}`);
