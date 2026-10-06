// Like viem's test setup: a prool proxy starts one anvil per `/<poolId>` on the
// first request. Each test process has its own proxy on a free port. Tests
// share the chain, so deploy fresh contracts instead of resetting it.

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

const poolId = Math.floor(Math.random() * 10_000) + 1;

export const anvil = defineAnvil({ chain: foundry, port: getFreePort() });

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
    getClient() {
      return createTestClient({
        account,
        chain,
        mode: "anvil",
        pollingInterval: 100,
        // Struct-log traces are larger than viem's default response limit.
        transport: http(rpcUrl, { maxResponseBodySize: false }),
      })
        .extend(publicActions)
        .extend(walletActions);
    },
    async start() {
      return await Server.create({
        instance: Instance.anvil({
          chainId: chain.id,
          hardfork: "Prague",
          // `debug_traceTransaction` returns struct logs only with this.
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
