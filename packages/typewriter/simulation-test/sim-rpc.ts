import { Duration, Effect } from "effect";
import { Hash } from "ox";
import {
  RpcHttpError,
  RpcNetworkError,
  type RpcRequest,
  RpcResponseError,
  type RpcTransport,
  type RpcTransportError,
} from "../src/rpc-transport";
import type { Chain } from "./chain";
import { SIM } from "./index";
import { makeRandom } from "./random";

/**
 * An `RpcTransport` for one simulated endpoint. Each call draws from its own
 * generator, keyed by the request and how many times the endpoint saw it.
 */
export function makeSimTransport({
  chain,
  index,
}: {
  chain: Chain;
  index: number;
}): RpcTransport {
  const origin = `sim-${index}`;
  const {
    latencyMs: [latencyMin, latencyMax],
    errorRate,
    applyThenErrorRate,
  } = SIM.transports[index]!;

  const occurrences = new Map<string, number>();

  // Anvil answers `eth_sendRawTransactionSync` once the block is mined, and the
  // simulation mines only between requests, so it sends and then polls. Like a
  // node, it does not send a transaction it already has.
  const send = (request: RpcRequest) =>
    request.method !== "eth_sendRawTransactionSync"
      ? chain.request(request)
      : Effect.gen(function* () {
          const [raw] = request.params;
          const hash = Hash.keccak256(raw);
          const known = yield* chain.request({
            method: "eth_getTransactionByHash",
            params: [hash],
          });
          if (known === null) {
            yield* chain.request({
              method: "eth_sendRawTransaction",
              params: [raw],
            });
          }
          while (true) {
            const receipt = yield* chain.request({
              method: "eth_getTransactionReceipt",
              params: [hash],
            });
            if (receipt !== null) return receipt;
            yield* Effect.sleep(Duration.millis(10));
          }
        });

  const request = (request: RpcRequest) =>
    Effect.gen(function* () {
      const { method } = request;

      const key = JSON.stringify([method, request.params]);
      const occurrence = occurrences.get(key) ?? 0;
      occurrences.set(key, occurrence + 1);
      const random = yield* makeRandom(
        SIM.seed,
        `${index}:${key}:${occurrence}`,
      );
      const between = (min: number, max: number) =>
        min + random.nextDoubleUnsafe() * (max - min);

      const draw = random.nextDoubleUnsafe();

      const injected = (): RpcTransportError => {
        const kind = random.nextDoubleUnsafe();
        if (kind < 1 / 3) {
          return new RpcResponseError({
            method,
            origin,
            status: 200,
            error: { code: -32603, message: "simulated internal error" },
          });
        }
        if (kind < 2 / 3) {
          return new RpcHttpError({
            method,
            origin,
            status: 502,
            body: "simulated bad gateway",
          });
        }
        return new RpcNetworkError({
          method,
          origin,
          cause: new Error("simulated connection reset"),
        });
      };

      const latency = between(latencyMin, latencyMax);
      yield* Effect.sleep(Duration.millis(latency));

      if (draw < errorRate) return yield* Effect.fail(injected());
      const result = yield* send(request);
      if (draw < errorRate + applyThenErrorRate)
        return yield* Effect.fail(injected());
      return result;
    });

  return { origin, request: request as RpcTransport["request"] };
}
