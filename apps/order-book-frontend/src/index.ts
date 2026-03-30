import { serve } from "bun";
import type { Chain, Hex } from "viem";
import {
  createPublicClient,
  createWalletClient,
  http,
  parseSignature,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import type {
  AddAccount,
  AddAsset,
  AddInstrument,
  CloseOrder,
  LimitOrder,
  LimitOrderResolution,
  MarketOrder,
  MarketOrderResolution,
  SignedMutation,
  State,
} from "./api";
import { MutationType, resolveAndOrderMutations } from "./api";
import { CHAIN, EXCHANGE_ADDRESS, RPC_URL } from "./constants";
import index from "./index.html";

const bootId = crypto.randomUUID();

const state: State<bigint> = {
  assets: [],
  accounts: [],
  instruments: [],
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// @ts-expect-error
if (!process.env.DEPLOYER_PRIVATE_KEY) {
  throw new Error("DEPLOYER_PRIVATE_KEY env var is required");
}
// @ts-expect-error
const DEPLOYER_PRIVATE_KEY = process.env.DEPLOYER_PRIVATE_KEY as `0x${string}`;

const deployerAccount = privateKeyToAccount(DEPLOYER_PRIVATE_KEY);

const deployerClient = createWalletClient({
  account: deployerAccount,
  transport: http(RPC_URL, { retryCount: 0 }),
  chain: CHAIN as Chain,
});

const publicClient = createPublicClient({
  transport: http(RPC_URL, { retryCount: 0 }),
  chain: CHAIN as Chain,
});

type QueuedMutation<
  mutation extends
    | MarketOrder<bigint>
    | LimitOrder<bigint>
    | CloseOrder
    | AddAccount
    | AddInstrument
    | AddAsset =
    | MarketOrder<bigint>
    | LimitOrder<bigint>
    | CloseOrder
    | AddAccount
    | AddInstrument
    | AddAsset,
  ///
  resolution = mutation extends MarketOrder<bigint>
    ? MarketOrderResolution<bigint>
    : mutation extends LimitOrder<bigint>
      ? LimitOrderResolution<bigint>
      : mutation extends CloseOrder
        ? undefined
        : mutation extends AddAccount
          ? undefined
          : mutation extends AddInstrument
            ? undefined
            : mutation extends AddAsset
              ? undefined
              :
                  | LimitOrderResolution<bigint>
                  | MarketOrderResolution<bigint>
                  | undefined,
> = {
  id: string;
  mutation: mutation;
  signature?: { v: number; r: Hex; s: Hex };
  resolve: resolution extends undefined
    ? undefined
    : (result: resolution) => void;
};

const FLUSH_INTERVAL_MS = 50;

let mutationQueue: QueuedMutation[] = [];

type Mutation =
  | MarketOrder<bigint>
  | LimitOrder<bigint>
  | CloseOrder
  | AddAccount
  | AddInstrument
  | AddAsset;

function queueMutation<mutation extends Mutation>(
  mutation: mutation,
  signature?: { v: number; r: Hex; s: Hex },
): mutation["type"] extends MutationType.MarketOrder
  ? Promise<MarketOrderResolution<bigint>>
  : mutation["type"] extends MutationType.LimitOrder
    ? Promise<LimitOrderResolution<bigint>>
    : undefined {
  if (mutation.type === MutationType.MarketOrder) {
    const { promise, resolve } =
      Promise.withResolvers<MarketOrderResolution<bigint>>();
    mutationQueue.push({
      id: mutation.id,
      mutation,
      signature,
      resolve: resolve as QueuedMutation["resolve"],
    });

    // @ts-ignore
    return promise;
  }

  if (mutation.type === MutationType.LimitOrder) {
    const { promise, resolve } =
      Promise.withResolvers<LimitOrderResolution<bigint>>();
    mutationQueue.push({
      id: mutation.id,
      mutation,
      signature,
      resolve: resolve as QueuedMutation["resolve"],
    });

    // @ts-ignore
    return promise;
  }

  mutationQueue.push({
    id: mutation.id,
    mutation,
    signature,
    resolve: undefined,
  });

  // @ts-ignore
  return undefined;
}

async function flushMutationQueue() {
  if (mutationQueue.length === 0) return;

  const batch = mutationQueue;
  mutationQueue = [];

  try {
    const resolved = resolveAndOrderMutations(
      state,
      batch.map((m) => m.mutation),
    );

    // TODO: encode resolved mutations into Exchange.execute() calldata
    // TODO: submit transaction on-chain using deployerClient, publicClient, EXCHANGE_ADDRESS

    for (const entry of resolved) {
      const id = Array.isArray(entry) ? entry[0].id : entry.id;
      const queued = batch.find((m) => m.mutation.id === id);
      if (!queued) continue;
      if (Array.isArray(entry)) {
        queued.resolve?.(entry[1]);
      }
    }
  } catch (err) {
    console.error("Bundle resolution failed:", err);
    // TODO(kyle) reject
  }
}

(async function flushLoop() {
  while (true) {
    await sleep(FLUSH_INTERVAL_MS);
    flushMutationQueue();
  }
})();

const server = serve({
  routes: {
    "/api/boot-id": {
      GET: () => Response.json({ id: bootId }),
    },

    "/api/state": {
      GET: () => {
        const serialized: State<string> = {
          assets: state.assets,
          accounts: state.accounts.map((a) => ({
            nonce: a.nonce,
            balances: Object.fromEntries(
              Object.entries(a.balances).map(([k, v]) => [k, v.toString()]),
            ),
            orders: a.orders.map((o) => ({
              ...o,
              quantity: o.quantity.toString(),
            })),
          })),
          instruments: state.instruments.map((inst) => ({
            baseId: inst.baseId,
            quoteId: inst.quoteId,
            bids: Object.fromEntries(
              Object.entries(inst.bids).map(([k, t]) => [
                k,
                {
                  quantity: t.quantity.toString(),
                  remainingQuantity: t.remainingQuantity.toString(),
                  volume: t.volume,
                },
              ]),
            ),
            asks: Object.fromEntries(
              Object.entries(inst.asks).map(([k, t]) => [
                k,
                {
                  quantity: t.quantity.toString(),
                  remainingQuantity: t.remainingQuantity.toString(),
                  volume: t.volume,
                },
              ]),
            ),
          })),
        };
        return Response.json(serialized);
      },
    },

    "/api/add-account": {
      POST: async () => {
        const privateKey = generatePrivateKey();
        const wallet = privateKeyToAccount(privateKey);

        const id = crypto.randomUUID();
        queueMutation({
          id,
          type: MutationType.AddAccount,
          addr: wallet.address,
        });

        return Response.json({
          id,
          address: wallet.address,
          privateKey,
          bootId,
        });
      },
    },

    "/api/add-asset": {
      POST: async (req) => {
        const body = (await req.json()) as AddAsset;

        const id = crypto.randomUUID();
        queueMutation({
          ...body,
          id,
          type: MutationType.AddAsset,
        });

        return Response.json({ id });
      },
    },

    "/api/add-instrument": {
      POST: async (req) => {
        const body = (await req.json()) as AddInstrument;

        const id = crypto.randomUUID();
        queueMutation({
          ...body,
          id,
          type: MutationType.AddInstrument,
        });

        return Response.json({ id });
      },
    },

    "/api/market-order": {
      POST: async (req) => {
        const body = (await req.json()) as SignedMutation<MarketOrder>;

        const id = crypto.randomUUID();
        const { v, r, s } = parseSignature(body.signature);
        const resolution = await queueMutation(
          {
            id,
            type: MutationType.MarketOrder,
            quantity: BigInt(body.quantity),
            minReceivedQuantity: BigInt(body.minReceivedQuantity),
            marketId: body.marketId,
            accountId: body.accountId,
            bidOrAsk: body.bidOrAsk,
          },
          { v: Number(v), r, s },
        );

        return Response.json({
          id,
          fills: resolution.fills.map((f) => ({
            quantity: f.quantity.toString(),
            tickId: f.tickId,
          })),
        });
      },
    },

    "/api/limit-order": {
      POST: async (req) => {
        const body = (await req.json()) as SignedMutation<LimitOrder>;

        const id = crypto.randomUUID();
        const { v, r, s } = parseSignature(body.signature);
        const resolution = await queueMutation(
          {
            id,
            type: MutationType.LimitOrder,
            quantity: BigInt(body.quantity),
            marketId: body.marketId,
            accountId: body.accountId,
            tickId: body.tickId,
            bidOrAsk: body.bidOrAsk,
          },
          { v: Number(v), r, s },
        );

        return Response.json({
          id,
          fills: resolution.fills.map((f) => ({
            quantity: f.quantity.toString(),
            tickId: f.tickId,
          })),
        });
      },
    },

    "/api/close-order": {
      POST: async (req) => {
        const body = (await req.json()) as SignedMutation<CloseOrder>;

        const id = crypto.randomUUID();
        const { v, r, s } = parseSignature(body.signature);
        queueMutation(
          {
            id,
            type: MutationType.CloseOrder,
            accountId: body.accountId,
            orderId: body.orderId,
          },
          { v: Number(v), r, s },
        );

        return Response.json({ id });
      },
    },

    "/*": index,
  },

  development: process.env.NODE_ENV !== "production" && {
    hmr: true,
    console: true,
  },
});

console.log(`Server running at ${server.url}`);
