import { expect, test } from "bun:test";
import { Effect } from "effect";
import { TEST_RPC_URL } from "../test/setup";
import { layerRpcLive, Rpc } from "./rpc";

test("Rpc service makes an EIP-1193 request to Anvil", async () => {
  const chainId = await Effect.runPromise(
    Effect.gen(function* () {
      const rpc = yield* Rpc;
      return yield* rpc.request({ method: "eth_chainId" });
    }).pipe(Effect.provide(layerRpcLive({ rpcUrls: [TEST_RPC_URL] }))),
  );

  expect(chainId).toBe("0x7a69");
});
