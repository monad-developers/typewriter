import { serve } from "bun";
import type { Address, Chain } from "viem";
import { createWalletClient, encodeFunctionData, http, parseEther } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import {
  CHAIN,
  CHAIN_ID,
  RPC_URL,
  TOKEN_ABI,
  TOKEN_ADDRESS,
} from "./constants";
import index from "./index.html";
import { raceSendRawTransactionSync } from "./lib/raceSendRawTransactionSync";

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
    "/sign-in": {
      POST: async () => {
        const privateKey = generatePrivateKey();
        const account = privateKeyToAccount(privateKey);

        const fundingRequest = await deployerClient.prepareTransactionRequest({
          to: account.address,
          value: parseEther("1"),
        });
        const fundingSigned =
          await deployerClient.signTransaction(fundingRequest);
        await raceSendRawTransactionSync(
          RPC_URL,
          fundingSigned,
          CHAIN_ID,
        );

        const mintRequest = await deployerClient.prepareTransactionRequest({
          to: TOKEN_ADDRESS,
          data: encodeFunctionData({
            abi: TOKEN_ABI,
            functionName: "mint",
            args: [account.address, parseEther("100")],
          }),
        });
        const mintSigned = await deployerClient.signTransaction(mintRequest);
        await raceSendRawTransactionSync(
          RPC_URL,
          mintSigned,
          CHAIN_ID,
        );

        createdAddresses.push(account.address);

        return Response.json({
          address: account.address,
          privateKey,
        });
      },
    },
    "/addresses": {
      GET: () => {
        return Response.json([deployerAccount.address, ...createdAddresses]);
      },
    },
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
