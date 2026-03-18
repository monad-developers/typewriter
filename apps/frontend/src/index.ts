import { serve } from "bun";
import type { Address, Chain } from "viem";
import { createWalletClient, encodeFunctionData, http, parseEther } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { sendRawTransactionSync } from "viem/actions";
import { CHAIN, RPC_URL, TOKEN_ABI, TOKEN_ADDRESS } from "./constants";
import type { State, Transfer } from "./fast/api";
import fast from "./fast/index.html";
import index from "./index.html";

// ---------------------------------------------------------------------------
// Fast server — in-memory state
// ---------------------------------------------------------------------------
const state = {
  totalSupply: 0n,
  accounts: {},
} as State<bigint>;

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
          balance: (state.accounts[address]?.balance ?? 0n).toString(),
          nonce: state.accounts[address]?.nonce ?? 0,
        } satisfies State["accounts"][Address]);
      },
    },
    "/api/fast/transfer": {
      POST: async (req) => {
        const { from, to, amount } = (await req.json()) as Transfer;
        const amountBigInt = BigInt(amount);
        const fromBalance = state.accounts[from]?.balance ?? 0n;
        if (fromBalance < amountBigInt) {
          return new Response("Insufficient balance", { status: 400 });
        }
        state.accounts[from] = {
          balance: fromBalance - amountBigInt,
          nonce: (state.accounts[from]?.nonce ?? 0) + 1,
        };
        state.accounts[to] = {
          balance: (state.accounts[to]?.balance ?? 0n) + amountBigInt,
          nonce: state.accounts[to]?.nonce ?? 0,
        };
        return new Response(null, { status: 200 });
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
          deployerAccount.address,
          ...Object.keys(state.accounts),
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
