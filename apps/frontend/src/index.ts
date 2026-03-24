import { serve } from "bun";
import type { Address, Chain, Hex } from "viem";
import {
  createPublicClient,
  createWalletClient,
  encodeAbiParameters,
  encodeFunctionData,
  http,
  parseEther,
  parseSignature,
  recoverTypedDataAddress,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { sendRawTransactionSync } from "viem/actions";
import {
  CHAIN,
  CHAIN_ID,
  RPC_URL,
  TOKEN_ABI,
  TOKEN_ADDRESS,
  TOKEN_FAST_ABI,
  TOKEN_FAST_ADDRESS,
} from "./constants";
import type { SignedTransfer, State } from "./fast/api";
import fast from "./fast/index.html";
import index from "./index.html";

// ---------------------------------------------------------------------------
// Boot IDs — invalidate client auth when the server restarts
// ---------------------------------------------------------------------------
const normalBootId = crypto.randomUUID();
const fastBootId = crypto.randomUUID();

// ---------------------------------------------------------------------------
// Fast server — in-memory state
// ---------------------------------------------------------------------------
const state = {
  totalSupply: 0n,
  accounts: {},
} as State<bigint>;

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

const createdAddresses: Address[] = [];

const EIP712_DOMAIN = {
  name: "FastTransfer",
  version: "1",
  chainId: CHAIN_ID,
  verifyingContract: TOKEN_FAST_ADDRESS,
} as const;

const EIP712_TYPES = {
  Transfer: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "amount", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
} as const;

// ---------------------------------------------------------------------------
// Mutation queue — batched every 400ms into a single TokenFast.execute() call
// ---------------------------------------------------------------------------
// Mutation enum values matching the Solidity contract
const MUTATION_TRANSFER = 0;
const MUTATION_MINT = 1;

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

let mutationQueue: Mutation[] = [];
const mutations = new Map<string, Mutation>();

async function flushMutationQueue() {
  if (mutationQueue.length === 0) return;

  const batch = mutationQueue;
  mutationQueue = [];

  try {
    const data = encodeFunctionData({
      abi: TOKEN_FAST_ABI,
      functionName: "execute",
      args: [
        {
          mutations: batch.map((m) => m.mutationType),
          mutationData: batch.map((m) => m.mutationData),
          v: batch.map((m) => m.v),
          r: batch.map((m) => m.r),
          s: batch.map((m) => m.s),
        },
      ],
    });

    const { accessList, gasUsed } = await publicClient.createAccessList({
      account: deployerAccount.address,
      to: TOKEN_FAST_ADDRESS,
      data,
    });

    const request = await deployerClient.prepareTransactionRequest({
      to: TOKEN_FAST_ADDRESS,
      data,
      accessList,
      gas: gasUsed + gasUsed / 10n,
    });
    const signed = await deployerClient.signTransaction(request);
    await sendRawTransactionSync(deployerClient, {
      serializedTransaction: signed,
    });

    for (const m of batch) m.status = "proposed";

    // Simulate finalization + verification delays
    await sleep(400);
    for (const m of batch) m.status = "voted";
    await sleep(400);
    for (const m of batch) m.status = "finalized";
    await sleep(1200);
    for (const m of batch) m.status = "verified";
  } catch (err) {
    console.error("Bundle submission failed:", err);
  }
}

(async function flushLoop() {
  while (true) {
    await sleep(450 - (Date.now() % 400));
    await flushMutationQueue();
  }
})();

const server = serve({
  routes: {
    "/api/sign-in": {
      POST: async () => {
        const privateKey = generatePrivateKey();
        const account = privateKeyToAccount(privateKey);

        const fundingRequest = await deployerClient.prepareTransactionRequest({
          to: account.address,
          value: parseEther("1"),
        });
        const fundingSigned =
          await deployerClient.signTransaction(fundingRequest);
        await sendRawTransactionSync(deployerClient, {
          serializedTransaction: fundingSigned,
        });

        const mintRequest = await deployerClient.prepareTransactionRequest({
          to: TOKEN_ADDRESS,
          data: encodeFunctionData({
            abi: TOKEN_ABI,
            functionName: "mint",
            args: [account.address, parseEther("100")],
          }),
        });
        const mintSigned = await deployerClient.signTransaction(mintRequest);
        await sendRawTransactionSync(deployerClient, {
          serializedTransaction: mintSigned,
        });

        createdAddresses.push(account.address);

        return Response.json({
          address: account.address,
          privateKey,
          bootId: normalBootId,
        });
      },
    },
    "/api/boot-id": {
      GET: () => Response.json({ id: normalBootId }),
    },
    "/api/fast/account": {
      GET: (req) => {
        const address = new URL(req.url).searchParams.get(
          "address",
        ) as Address | null;
        if (!address) return new Response("Bad Request", { status: 400 });
        return Response.json({
          balance: (state.accounts[address]?.balance ?? 0n).toString(),
          nonce: state.accounts[address]?.nonce ?? 0,
        } satisfies State["accounts"][Address]);
      },
    },
    "/api/fast/transfer": {
      POST: async (req) => {
        const { from, to, amount, nonce, deadline, signature } =
          (await req.json()) as SignedTransfer;

        if (deadline < Math.floor(Date.now() / 1000)) {
          return new Response("Signature expired", { status: 400 });
        }

        const expectedNonce = state.accounts[from]?.nonce ?? 0;
        if (nonce !== expectedNonce) {
          return new Response("Invalid nonce", { status: 400 });
        }

        const amountBigInt = BigInt(amount);
        const recovered = await recoverTypedDataAddress({
          domain: EIP712_DOMAIN,
          types: EIP712_TYPES,
          primaryType: "Transfer",
          message: {
            from,
            to,
            amount: amountBigInt,
            nonce: BigInt(nonce),
            deadline: BigInt(deadline),
          },
          signature,
        });
        if (recovered !== from) {
          return new Response("Invalid signature", { status: 401 });
        }
        const fromBalance = state.accounts[from]?.balance ?? 0n;
        if (fromBalance < amountBigInt) {
          return new Response("Insufficient balance", { status: 400 });
        }

        // Update in-memory state immediately (optimistic)
        state.accounts[from] = {
          balance: fromBalance - amountBigInt,
          nonce: expectedNonce + 1,
        };
        state.accounts[to] = {
          balance: (state.accounts[to]?.balance ?? 0n) + amountBigInt,
          nonce: state.accounts[to]?.nonce ?? 0,
        };

        // Queue on-chain settlement
        const mutationData = encodeAbiParameters(
          [
            { type: "address", name: "from" },
            { type: "address", name: "to" },
            { type: "uint256", name: "amount" },
            { type: "uint256", name: "nonce" },
            { type: "uint256", name: "deadline" },
          ],
          [from, to, amountBigInt, BigInt(nonce), BigInt(deadline)],
        );

        const { v, r, s } = parseSignature(signature);

        const id = crypto.randomUUID();
        const mutation: Mutation = {
          mutationType: MUTATION_TRANSFER,
          mutationData,
          v: Number(v),
          r,
          s,
          status: "accepted",
        };
        mutations.set(id, mutation);
        mutationQueue.push(mutation);

        return Response.json({ id });
      },
    },
    "/api/fast/transfer/:id/status": {
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
    "/api/addresses": {
      GET: () => {
        return Response.json([deployerAccount.address, ...createdAddresses]);
      },
    },
    "/api/fast/addresses": {
      GET: () => {
        return Response.json([
          ...new Set([deployerAccount.address, ...Object.keys(state.accounts)]),
        ]);
      },
    },
    "/api/fast/sign-in": {
      POST: async () => {
        const privateKey = generatePrivateKey();
        const account = privateKeyToAccount(privateKey);

        const mintAmount = parseEther("100");

        // Update in-memory state immediately
        state.accounts[account.address] = {
          balance: mintAmount,
          nonce: 0,
        };

        // Queue a Mint mutation for on-chain settlement
        const mutationData = encodeAbiParameters(
          [
            { type: "address", name: "to" },
            { type: "uint256", name: "amount" },
          ],
          [account.address, mintAmount],
        );

        mutationQueue.push({
          mutationType: MUTATION_MINT,
          mutationData,
          v: 0,
          r: "0x0000000000000000000000000000000000000000000000000000000000000000",
          s: "0x0000000000000000000000000000000000000000000000000000000000000000",
          status: "accepted",
        });

        return Response.json({
          address: account.address,
          privateKey,
          bootId: fastBootId,
        });
      },
    },
    "/api/fast/boot-id": {
      GET: () => Response.json({ id: fastBootId }),
    },
    "/fast": fast,
    "/fast/*": fast,
    // Serve index.html for all unmatched routes.
    "/*": index,
  },

  development: process.env.NODE_ENV !== "production" && {
    // Enable browser hot reloading in development
    hmr: true,

    // Echo console logs from the browser to the server
    console: true,
  },
});

console.log(`🚀 Server running at ${server.url}`);
