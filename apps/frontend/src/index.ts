import { serve } from "bun";
import type { Address, Chain, Hash } from "viem";
import {
  createWalletClient,
  encodeFunctionData,
  formatEther,
  http,
  parseEther,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { sendRawTransactionSync } from "viem/actions";
import { CHAIN, RPC_URL, TOKEN_ABI, TOKEN_ADDRESS } from "./constants";
import type {
  GetAccountResponse,
  PostTransferRequest,
  PostTransferResponse,
} from "./fast/api";
import fast from "./fast/index.html";
import index from "./index.html";

// ---------------------------------------------------------------------------
// Fast server — in-memory state
// ---------------------------------------------------------------------------
const fastBalances = new Map<Address, bigint>();
const fastTxCounts = new Map<Address, number>();

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
        });
      },
    },
    "/api/fast/account": {
      GET: (req) => {
        const address = new URL(req.url).searchParams.get(
          "address",
        ) as Address | null;
        if (!address) return new Response("Bad Request", { status: 400 });
        return Response.json({
          address,
          balance: formatEther(fastBalances.get(address) ?? 0n),
          txCount: fastTxCounts.get(address) ?? 0,
        } satisfies GetAccountResponse);
      },
    },
    "/api/fast/transfer": {
      POST: async (req) => {
        const serverStart = performance.now();
        const { from, to, amount } =
          (await req.json()) as PostTransferRequest;
        const amountWei = parseEther(amount.toString());
        const fromBalance = fastBalances.get(from) ?? 0n;
        if (fromBalance < amountWei) {
          return new Response("Insufficient balance", { status: 400 });
        }
        fastBalances.set(from, fromBalance - amountWei);
        fastBalances.set(to, (fastBalances.get(to) ?? 0n) + amountWei);
        fastTxCounts.set(from, (fastTxCounts.get(from) ?? 0) + 1);
        const bytes = crypto.getRandomValues(new Uint8Array(32));
        const hash =
          `0x${Array.from(bytes)
            .map((b) => b.toString(16).padStart(2, "0"))
            .join("")}` as Hash;
        const submissionLatency = performance.now() - serverStart;
        return Response.json({
          hash,
          submissionLatency,
        } satisfies PostTransferResponse);
      },
    },
    "/api/addresses": {
      GET: () => {
        return Response.json([deployerAccount.address, ...createdAddresses]);
      },
    },
    "/api/fast/addresses": {
      GET: () => {
        return Response.json([deployerAccount.address, ...createdAddresses]);
      },
    },
    "/api/fast/sign-in": {
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

        fastBalances.set(account.address, parseEther("100"));
        fastTxCounts.set(account.address, 0);

        return Response.json({
          address: account.address,
          privateKey,
        });
      },
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
