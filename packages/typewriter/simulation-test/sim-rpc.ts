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
import type { Plan } from "./plan";
import { Rng } from "./random";

/** Past the runtime's 5s request timeout. */
const SLOW_MS = [6_000, 10_000] as const;

/**
 * An `RpcTransport` for one simulated endpoint. Each call draws from its own
 * generator, keyed by the request and how many times the endpoint saw it.
 */
export function makeSimTransport({
  plan,
  chain,
  index,
}: {
  plan: Plan;
  chain: Chain;
  index: number;
}): RpcTransport {
  const origin = `sim-${index}`;
  const {
    latencyMs: [latencyMin, latencyMax],
    errorRate,
    applyThenErrorRate,
    lagMs,
    slowRate,
  } = plan.transports[index]!;

  const occurrences = new Map<string, number>();

  // The endpoint sees the chain as it was `lagMs` ago, but never before the
  // run started, when the contract is deployed. It fails a read of a block it
  // does not have.
  const read = <request extends RpcRequest>(request: request) =>
    Effect.gen(function* () {
      const asOfMs = Math.max(
        (yield* Clock.currentTimeMillis) - lagMs,
        plan.chain.genesisTimestamp * 1000,
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
      const random = new Rng(plan.seed, `${index}:${key}:${occurrence}`);
      const draw = random.next();

      const injected = (): RpcTransportError => {
        const kind = random.next();
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

      const latency = random.float(latencyMin, latencyMax);
      yield* Effect.sleep(Duration.millis(latency));

      if (draw < errorRate) return yield* injected();
      // A node that accepts a transaction and then loses it.
      if (
        method === "eth_sendRawTransaction" &&
        random.bool(plan.chain.sendDropRate)
      ) {
        return Hash.keccak256((request.params as [Hex.Hex])[0]);
      }
      const result = yield* read(request);
      if (draw < errorRate + applyThenErrorRate) return yield* injected();
      if (slowRate > 0) {
        // Its own generator, so seeds without slow requests draw as before.
        const slow = new Rng(plan.seed, `${index}:${key}:${occurrence}:slow`);
        if (slow.bool(slowRate)) {
          yield* Effect.sleep(
            Duration.millis(slow.float(SLOW_MS[0], SLOW_MS[1])),
          );
        }
      }
      return result;
    });

  return { origin, request: request as RpcTransport["request"] };
}
