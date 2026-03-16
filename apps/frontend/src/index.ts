import { serve } from "bun";
import {
  createWalletClient,
  http,
  parseEther,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { anvil } from "viem/chains";
import type { Address } from "viem";
import index from "./index.html";

const DEPLOYER_PRIVATE_KEY =
  (process.env.DEPLOYER_PRIVATE_KEY as `0x${string}`) ??
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

const RPC_URL = process.env.BUN_PUBLIC_RPC_URL ?? "http://localhost:8545";

const deployerAccount = privateKeyToAccount(DEPLOYER_PRIVATE_KEY);

const deployerClient = createWalletClient({
  account: deployerAccount,
  transport: http(RPC_URL),
  chain: anvil,
});

const createdAddresses: Address[] = [];

const server = serve({
  routes: {
    "/sign-in": {
      POST: async () => {
        const privateKey = generatePrivateKey();
        const account = privateKeyToAccount(privateKey);

        const hash = await deployerClient.sendTransaction({
          to: account.address,
          value: parseEther("1"),
        });

        createdAddresses.push(account.address);

        return Response.json({
          address: account.address,
          privateKey,
          fundingTxHash: hash,
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
