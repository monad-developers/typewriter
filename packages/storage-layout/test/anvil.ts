// A local anvil node for tests, in the style of viem's `test/src/anvil.ts`.
//
// A prool proxy server listens on `port`. The first request to
// `http://127.0.0.1:<port>/<poolId>` starts an anvil instance for that id, and
// later requests reuse it. Each `bun test` process (one per worker with
// `--parallel`) loads `test/setup.ts`, which starts its own proxy on a free
// port, so workers never share a chain. Tests in one file run in series and
// share the chain: deploy fresh contracts instead of resetting state.

import { Instance, Server } from "prool";
import {
  type Chain,
  createTestClient,
  http,
  publicActions,
  walletActions,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { foundry } from "viem/chains";

/** Anvil's first default dev account. */
export const account = privateKeyToAccount(
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
);

export const poolId = Math.floor(Math.random() * 10_000) + 1;

export const anvil = defineAnvil({ chain: foundry, port: getFreePort() });

// -----------------------------------------------------------------------------
// Utilities

function defineAnvil<const chain extends Chain>(parameters: {
  chain: chain;
  port: number;
}) {
  const { chain, port } = parameters;
  const rpcUrl = `http://127.0.0.1:${port}/${poolId}`;

  return {
    chain,
    port,
    rpcUrl,
    /** A viem client with public, wallet, and anvil test actions. */
    getClient() {
      return createTestClient({
        account,
        chain,
        mode: "anvil",
        pollingInterval: 100,
        transport: http(rpcUrl),
      })
        .extend(publicActions)
        .extend(walletActions);
    },
    /** Start the proxy server. Resolves to a function that stops it. */
    async start() {
      return await Server.create({
        instance: Instance.anvil({
          chainId: chain.id,
          hardfork: "Prague",
          // Record opcode steps, so `debug_traceTransaction` returns struct
          // logs with stack and memory.
          stepsTracing: true,
        }),
        port,
      }).start();
    },
  } as const;
}

function getFreePort(): number {
  const server = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: { data() {} },
  });
  const { port } = server;
  server.stop(true);
  return port;
}
