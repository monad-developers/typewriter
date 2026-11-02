import { Context, Data, Duration, Effect, Layer, Schedule } from "effect";
import type { Hex } from "ox";
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
}> {
  override get message() {
    return `Failed '${this.method}' request to ${this.origin}: timed out after ${Duration.format(REQUEST_TIMEOUT)}`;
  }
}

/**
 * The provider returned `null` for a block. It may not have the block yet,
 * when it is behind another provider, so a request retries it.
 */
export class BlockNotFoundError extends Data.TaggedError("BlockNotFoundError")<{
  block: Hex.Hex | bigint | "latest";
}> {
  override get message() {
    return `Block ${this.block} not found`;
  }
}

export type RpcError = RpcTransportError | RpcTimeoutError | BlockNotFoundError;

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
    /**
     * Sends `request` to every provider, retrying each on its own, for checks
     * that must hold on all of them.
     */
    requestEach: <request extends RpcRequest>(
      request: request,
    ) => Effect.Effect<
      { origin: string; result: RpcResult<request["method"]> }[],
      RpcError
    >;
  }
>()("typewriter/Rpc") {}

const REQUEST_TIMEOUT = Duration.seconds(5);
const RETRY_TIMES = 8;
const RETRY_SCHEDULE = Schedule.min([
  Schedule.exponential(Duration.millis(10)),
  Schedule.spaced(Duration.seconds(2)),
]).pipe(Schedule.jittered);

function shouldRetry(_method: RpcMethod, _error: RpcError): boolean {
  // TODO(kyle) dynamically decide based on `error`

  return true;
}

function blockFound<result>(
  request: RpcRequest,
  result: result,
): Effect.Effect<result, BlockNotFoundError> {
  const { method } = request;
  if (
    result !== null ||
    (method !== "eth_getBlockByHash" && method !== "eth_getBlockByNumber")
  ) {
    return Effect.succeed(result);
  }
  const [id] = request.params as unknown as [Hex.Hex | "latest"];
  return Effect.fail(
    new BlockNotFoundError({
      block:
        method === "eth_getBlockByNumber" && id !== "latest" ? BigInt(id) : id,
    }),
  );
}

function makeRpc(
  transports: readonly [RpcTransport, ...RpcTransport[]],
): Context.Service.Shape<typeof Rpc> {
  // Round-robin cursor shared across requests; advanced once per attempt so
  // retries rotate onto the next provider.
  let cursor = 0;

  const send = (
    transport: RpcTransport,
    request: RpcRequest,
    attempt: number,
  ) => {
    const { method } = request;
    return transport.request(request).pipe(
      Effect.timeoutOrElse({
        duration: REQUEST_TIMEOUT,
        orElse: () =>
          Effect.fail(
            new RpcTimeoutError({ method, origin: transport.origin }),
          ),
      }),
      Effect.flatMap((result) => blockFound(request, result)),
      Effect.tapError((error) =>
        Effect.logDebug("Failed RPC request", error).pipe(
          Effect.annotateLogs({ method, attempt }),
        ),
      ),
    );
  };

  const retry = <A>(method: RpcMethod, effect: Effect.Effect<A, RpcError>) =>
    effect.pipe(
      Effect.retry({
        schedule: RETRY_SCHEDULE,
        times: RETRY_TIMES,
        while: (error) => shouldRetry(method, error),
      }),
    );

  const request = (request: RpcRequest) => {
    let attempt = 0;
    return retry(
      request.method,
      Effect.suspend(() => {
        const transport = transports[cursor % transports.length]!;
        cursor += 1;
        attempt += 1;
        return send(transport, request, attempt);
      }),
    );
  };

  const requestEach = (request: RpcRequest) =>
    Effect.forEach(transports, (transport) => {
      let attempt = 0;
      return retry(
        request.method,
        Effect.suspend(() => {
          attempt += 1;
          return send(transport, request, attempt);
        }),
      ).pipe(Effect.map((result) => ({ origin: transport.origin, result })));
    });

  return Rpc.of({
    request: request as Rpc["Service"]["request"],
    requestEach: requestEach as Rpc["Service"]["requestEach"],
  });
}

export const layerRpc = (
  transports: readonly [RpcTransport, ...RpcTransport[]],
): Layer.Layer<Rpc> => Layer.sync(Rpc)(() => makeRpc(transports));
