import { serve } from "bun";
import type { Address, Chain } from "viem";
import {
  createWalletClient,
  encodeFunctionData,
  http,
  parseEther,
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

const pendingTransfers = new Set<string>();

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
  transport: http(RPC_URL),
  chain: CHAIN as Chain,
});

const createdAddresses: Address[] = [];

const EIP712_DOMAIN = {
  name: "FastTransfer",
  version: "1",
  chainId: CHAIN_ID,
  verifyingContract: TOKEN_ADDRESS,
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
        state.accounts[from] = {
          balance: fromBalance - amountBigInt,
          nonce: expectedNonce + 1,
        };
        state.accounts[to] = {
          balance: (state.accounts[to]?.balance ?? 0n) + amountBigInt,
          nonce: state.accounts[to]?.nonce ?? 0,
        };
        // TODO(kyle) this should be auto-increment
        const id = crypto.randomUUID();
        pendingTransfers.add(id);
        return Response.json({ id });
      },
    },
    "/api/fast/transfer/:id/status": {
      GET: (req) => {
        const id = req.params.id;
        if (!pendingTransfers.has(id)) {
          return new Response("Not Found", { status: 404 });
        }
        pendingTransfers.delete(id);

        const stream = new ReadableStream({
          async start(controller) {
            const send = (status: string) =>
              controller.enqueue(`data: ${JSON.stringify({ status })}\n\n`);

            await sleep(250);
            send("proposed");
            await sleep(650);
            send("voted");
            await sleep(1050);
            send("finalized");
            await sleep(2250);
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

        state.accounts[account.address] = {
          balance: parseEther("100"),
          nonce: 0,
        };

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
