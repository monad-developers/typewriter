import { Context, Data, Duration, Effect, Layer, Schedule } from "effect";
import type {
  RpcMethod,
  RpcRequest,
  RpcResult,
  RpcTransport,
  RpcTransportError,
} from "./rpc-transport";

/** An attempt did not complete in {@link REQUEST_TIMEOUT}. */
export class RpcTimeoutError extends Data.TaggedError("RpcTimeoutError")<{
  method: RpcMethod;
  origin: string;
}> {}

export type RpcError = RpcTransportError | RpcTimeoutError;

export class Rpc extends Context.Service<
  Rpc,
  {
    /**
     * Round-robins requests across the configured providers. Each attempt has
     * a {@link REQUEST_TIMEOUT} timeout, and retries advance to the next
     * provider.
     */
    request: <request extends RpcRequest>(
      request: request,
    ) => Effect.Effect<RpcResult<request["method"]>, RpcError>;
  }
>()("typewriter/Rpc") {}

const REQUEST_TIMEOUT = Duration.seconds(5);
const RETRY_TIMES = 8;
const RETRY_SCHEDULE = Schedule.exponential(Duration.millis(10)).pipe(
  Schedule.either(Schedule.spaced(Duration.seconds(2))),
  Schedule.jittered,
);

function shouldRetry(_method: RpcMethod, _error: RpcError): boolean {
  // TODO(kyle) dynamically decide based on `error`

  return true;
}

function makeRpc(
  transports: readonly [RpcTransport, ...RpcTransport[]],
): Context.Service.Shape<typeof Rpc> {
  // Round-robin cursor shared across requests; advanced once per attempt so
  // retries rotate onto the next provider.
  let cursor = 0;

  const request = (request: RpcRequest) => {
    const { method } = request;
    let attempt = 0;

    const send = Effect.suspend(() => {
      const transport = transports[cursor % transports.length]!;
      cursor += 1;
      attempt += 1;
      return transport.request(request).pipe(
        Effect.timeoutOrElse({
          duration: REQUEST_TIMEOUT,
          orElse: () =>
            Effect.fail(
              new RpcTimeoutError({ method, origin: transport.origin }),
            ),
        }),
        Effect.tapError((error) =>
          Effect.logDebug("rpc request failed").pipe(
            Effect.annotateLogs({
              method,
              origin: transport.origin,
              attempt,
              error,
            }),
          ),
        ),
      );
    });

    return send.pipe(
      Effect.retry({
        schedule: RETRY_SCHEDULE,
        times: RETRY_TIMES,
        while: (error) => shouldRetry(method, error),
      }),
    );
  };

  return Rpc.of({ request: request as Rpc["Service"]["request"] });
}

export const layerRpc = (
  transports: readonly [RpcTransport, ...RpcTransport[]],
): Layer.Layer<Rpc> => Layer.sync(Rpc)(() => makeRpc(transports));
