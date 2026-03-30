import { serve } from "bun";
import type { Chain, Hex } from "viem";
import {
  createPublicClient,
  createWalletClient,
  encodeAbiParameters,
  encodeFunctionData,
  http,
  parseSignature,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { sendRawTransactionSync } from "viem/actions";

import type {
  AddAssetInput,
  AddInstrumentInput,
  CloseOrderInput,
  LimitOrderInput,
  MarketOrderInput,
  SignedMutation,
  State,
} from "./api";
import { MutationType } from "./api";
import { CHAIN, EXCHANGE_ABI, EXCHANGE_ADDRESS, RPC_URL } from "./constants";
import index from "./index.html";

// ---------------------------------------------------------------------------
// Boot ID — invalidate client auth when the server restarts
// ---------------------------------------------------------------------------
const bootId = crypto.randomUUID();

// ---------------------------------------------------------------------------
// In-memory state (mirrors Exchange.sol State struct)
// ---------------------------------------------------------------------------
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

// ---------------------------------------------------------------------------
// Mutation queue — batched every 400ms into a single Exchange.execute() call
// ---------------------------------------------------------------------------

type MutationStatus =
  | "accepted"
  | "proposed"
  | "voted"
  | "finalized"
  | "verified";

type Mutation = {
  mutationType: number;
  mutationData: Hex;
  v: number;
  r: Hex;
  s: Hex;
  status: MutationStatus;
};

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

const server = serve({
  routes: {
    // ---- State ----
    "/api/boot-id": {
      GET: () => Response.json({ id: bootId }),
    },

    "/api/state": {
      GET: () => {
        // Serialize bigints to strings for JSON
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

    // ---- Mutation status (SSE) ----
    "/api/mutation/:id/status": {
      GET: (req) => {
        const id = req.params.id;
        const mutation = mutations.get(id);
        if (!mutation) {
          return new Response("Not Found", { status: 404 });
        }

        const stream = new ReadableStream({
          async start(controller) {
            const send = (status: MutationStatus) =>
              controller.enqueue(`data: ${JSON.stringify({ status })}\n\n`);

            let last: MutationStatus | undefined;
            while (mutation.status !== "verified") {
              if (mutation.status !== last) {
                last = mutation.status;
                send(mutation.status);
              }
              await sleep(10);
            }
            send("verified");
            controller.close();
          },
        });

        return new Response(stream, {
          headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
          },
        });
      },
    },

    // ---- Add Account ----
    "/api/add-account": {
      POST: async () => {
        const privateKey = generatePrivateKey();
        const account = privateKeyToAccount(privateKey);

        const accountId = state.accounts.length;
        state.accounts.push({
          nonce: 0,
          balances: {},
          orders: [],
        });

        // TODO: mint initial balances for demo purposes

        // const mutationData = encodeAbiParameters(
        //   [{ type: "address", name: "addr" }],
        //   [account.address],
        // );

        // const id = queueMutation(MutationType.AddAccount, mutationData);

        return Response.json({
          id: "0",
          accountId,
          address: account.address,
          privateKey,
          bootId,
        });
      },
    },

    // ---- Add Asset ----
    "/api/add-asset": {
      POST: async (req) => {
        const body = (await req.json()) as AddAssetInput;

        const assetId = state.assets.length;
        state.assets.push(body.asset);

        const mutationData = encodeAbiParameters(
          [{ type: "address", name: "asset" }],
          [body.asset],
        );

        const id = queueMutation(MutationType.AddAsset, mutationData);

        return Response.json({ id, assetId });
      },
    },

    // ---- Add Instrument ----
    "/api/add-instrument": {
      POST: async (req) => {
        const body = (await req.json()) as AddInstrumentInput;

        if (
          body.baseId >= state.assets.length ||
          body.quoteId >= state.assets.length
        ) {
          return new Response("Invalid asset ID", { status: 400 });
        }

        const instrumentId = state.instruments.length;
        state.instruments.push({
          baseId: body.baseId,
          quoteId: body.quoteId,
          bids: {},
          asks: {},
        });

        const mutationData = encodeAbiParameters(
          [
            { type: "uint64", name: "baseId" },
            { type: "uint64", name: "quoteId" },
          ],
          [BigInt(body.baseId), BigInt(body.quoteId)],
        );

        const id = queueMutation(MutationType.AddInstrument, mutationData);

        return Response.json({ id, instrumentId });
      },
    },

    // ---- Market Order ----
    "/api/market-order": {
      POST: async (req) => {
        const body = (await req.json()) as SignedMutation<MarketOrderInput>;

        if (body.marketId >= state.instruments.length) {
          return new Response("Invalid instrument", { status: 400 });
        }
        if (body.accountId >= state.accounts.length) {
          return new Response("Invalid account", { status: 400 });
        }

        // TODO: EIP-712 signature verification
        // TODO: implement matching engine — compute fills against opposing side
        // TODO: update in-memory state optimistically (settle fills, check slippage)

        const quantity = BigInt(body.quantity);
        const minReceivedQuantity = BigInt(body.minReceivedQuantity);

        // Encode (MarketOrder, MarketOrderResolution) together as the contract expects
        const mutationData = encodeAbiParameters(
          [
            {
              type: "tuple",
              name: "order",
              components: [
                { type: "uint256", name: "quantity" },
                { type: "uint256", name: "minReceivedQuantity" },
                { type: "uint64", name: "marketId" },
                { type: "uint64", name: "accountId" },
                { type: "uint8", name: "bidOrAsk" },
              ],
            },
            {
              type: "tuple",
              name: "resolution",
              components: [
                {
                  type: "tuple[]",
                  name: "fills",
                  components: [
                    { type: "uint256", name: "quantity" },
                    { type: "uint64", name: "tickId" },
                  ],
                },
              ],
            },
          ],
          [
            {
              quantity,
              minReceivedQuantity,
              marketId: BigInt(body.marketId),
              accountId: BigInt(body.accountId),
              bidOrAsk: body.bidOrAsk,
            },
            {
              fills: [], // TODO: compute fills from matching engine
            },
          ],
        );

        const { v, r, s } = parseSignature(body.signature);
        const id = queueMutation(MutationType.MarketOrder, mutationData, {
          v: Number(v),
          r,
          s,
        });

        return Response.json({ id });
      },
    },

    // ---- Limit Order ----
    "/api/limit-order": {
      POST: async (req) => {
        const body = (await req.json()) as SignedMutation<LimitOrderInput>;

        if (body.marketId >= state.instruments.length) {
          return new Response("Invalid instrument", { status: 400 });
        }
        if (body.accountId >= state.accounts.length) {
          return new Response("Invalid account", { status: 400 });
        }

        // TODO: EIP-712 signature verification
        // TODO: implement crossing logic — match fills against opposing side
        // TODO: update in-memory state optimistically:
        //   - settle any fills
        //   - add remaining quantity to tick
        //   - push Order to account.orders
        //   - debit account balance

        const quantity = BigInt(body.quantity);

        const mutationData = encodeAbiParameters(
          [
            {
              type: "tuple",
              name: "order",
              components: [
                { type: "uint256", name: "quantity" },
                { type: "uint64", name: "marketId" },
                { type: "uint64", name: "accountId" },
                { type: "uint64", name: "tickId" },
                { type: "uint8", name: "bidOrAsk" },
              ],
            },
            {
              type: "tuple",
              name: "resolution",
              components: [
                {
                  type: "tuple[]",
                  name: "fills",
                  components: [
                    { type: "uint256", name: "quantity" },
                    { type: "uint64", name: "tickId" },
                  ],
                },
              ],
            },
          ],
          [
            {
              quantity,
              marketId: BigInt(body.marketId),
              accountId: BigInt(body.accountId),
              tickId: BigInt(body.tickId),
              bidOrAsk: body.bidOrAsk,
            },
            {
              fills: [], // TODO: compute fills from crossing logic
            },
          ],
        );

        const { v, r, s } = parseSignature(body.signature);
        const id = queueMutation(MutationType.LimitOrder, mutationData, {
          v: Number(v),
          r,
          s,
        });

        return Response.json({ id });
      },
    },

    // ---- Close Order ----
    "/api/close-order": {
      POST: async (req) => {
        const body = (await req.json()) as SignedMutation<CloseOrderInput>;

        if (body.accountId >= state.accounts.length) {
          return new Response("Invalid account", { status: 400 });
        }
        const account = state.accounts[body.accountId];
        if (
          body.orderId >= account.orders.length ||
          account.orders[body.orderId].quantity === 0n
        ) {
          return new Response("Order not found", { status: 400 });
        }

        // TODO: EIP-712 signature verification
        // TODO: compute unfilled quantity (pro-rata fill calc matching Solidity)
        // TODO: credit balance back, update tick, delete order

        const mutationData = encodeAbiParameters(
          [
            { type: "uint64", name: "accountId" },
            { type: "uint64", name: "orderId" },
          ],
          [BigInt(body.accountId), BigInt(body.orderId)],
        );

        const { v, r, s } = parseSignature(body.signature);
        const id = queueMutation(MutationType.CloseOrder, mutationData, {
          v: Number(v),
          r,
          s,
        });

        return Response.json({ id });
      },
    },

    // ---- Frontend ----
    "/*": index,
  },

  development: process.env.NODE_ENV !== "production" && {
    hmr: true,
    console: true,
  },
});

console.log(`Server running at ${server.url}`);
