import { Clock, Duration, Effect } from "effect";
import { Hash, type Hex } from "ox";
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
    lagMs,
    outages,
  } = SIM.transports[index]!;

  const occurrences = new Map<string, number>();

  const outageRandom = Effect.runSync(makeRandom(SIM.seed, `${index}:outages`));
  const outageStarts: number[] = [];
  const inOutage = (nowMs: number) => {
    if (outages.everyMs === Infinity) return false;
    while ((outageStarts.at(-1) ?? 0) <= nowMs) {
      outageStarts.push(
        (outageStarts.at(-1) ?? SIM.chain.genesisTimestamp * 1000) +
          outages.durationMs +
          outageRandom.nextDoubleUnsafe() * 2 * outages.everyMs,
      );
    }
    return outageStarts.some(
      (start) => start <= nowMs && nowMs < start + outages.durationMs,
    );
  };

  // The endpoint sees the chain as it was `lagMs` ago, but never before the
  // run started, when the contract is deployed. It fails a read of a block it
  // does not have.
  const read = <request extends RpcRequest>(request: request) =>
    Effect.gen(function* () {
      const asOfMs = Math.max(
        (yield* Clock.currentTimeMillis) - lagMs,
        SIM.chain.genesisTimestamp * 1000,
      );
      const result = yield* chain.read(request, asOfMs);
      if (result !== undefined) return result;
      return yield* new RpcResponseError({
        method: request.method,
        origin,
        status: 200,
        error: { code: -32000, message: "unknown block" },
      });
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

      if (inOutage(yield* Clock.currentTimeMillis)) {
        return yield* new RpcNetworkError({
          method,
          origin,
          cause: new Error("simulated outage"),
        });
      }
      if (draw < errorRate) return yield* injected();
      // A node that accepts a transaction and then loses it.
      if (
        method === "eth_sendRawTransaction" &&
        random.nextDoubleUnsafe() < SIM.chain.sendDropRate
      ) {
        return Hash.keccak256((request.params as [Hex.Hex])[0]);
      }
      const result = yield* read(request);
      if (draw < errorRate + applyThenErrorRate) return yield* injected();
      return result;
    });

  return { origin, request: request as RpcTransport["request"] };
}
