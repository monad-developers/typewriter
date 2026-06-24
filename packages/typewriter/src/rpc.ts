import {
  Context,
  Data,
  Deferred,
  Duration,
  Effect,
  Layer,
  Schedule,
} from "effect";
import type {
  EIP1193Parameters,
  EIP1474Methods,
  RpcSchema,
  RpcSchemaOverride,
} from "viem";

type DerivedRpcSchema<
  rpcSchema extends RpcSchema | undefined,
  rpcSchemaOverride extends RpcSchemaOverride | undefined,
> = rpcSchemaOverride extends RpcSchemaOverride
  ? [rpcSchemaOverride & { Method: string }]
  : rpcSchema;

export type EffectEip1193RequestFn<
  rpcSchema extends RpcSchema | undefined = undefined,
> = <
  rpcSchemaOverride extends RpcSchemaOverride | undefined = undefined,
  parameters extends EIP1193Parameters<
    DerivedRpcSchema<rpcSchema, rpcSchemaOverride>
  > = EIP1193Parameters<DerivedRpcSchema<rpcSchema, rpcSchemaOverride>>,
  returnType = DerivedRpcSchema<rpcSchema, rpcSchemaOverride> extends RpcSchema
    ? Extract<
        DerivedRpcSchema<rpcSchema, rpcSchemaOverride>[number],
        { Method: parameters["method"] }
      >["ReturnType"]
    : unknown,
>(
  request: parameters,
) => Effect.Effect<returnType, RpcRequestError>;

type RawRequest = (request: {
  method: string;
  params?: unknown;
}) => Effect.Effect<unknown, RpcRequestError>;

type JsonRpcBody = {
  readonly jsonrpc: "2.0";
  readonly id: number;
  readonly method: string;
  readonly params?: unknown;
};

type JsonRpcResponse<TResult> =
  | {
      readonly jsonrpc?: string;
      readonly id?: number | string | null;
      readonly result: TResult;
      readonly error?: undefined;
    }
  | {
      readonly jsonrpc?: string;
      readonly id?: number | string | null;
      readonly result?: undefined;
      readonly error: {
        readonly code?: number;
        readonly message?: string;
        readonly data?: unknown;
      };
    };

export class RpcConfigError extends Data.TaggedError("RpcConfigError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export class RpcRequestError extends Data.TaggedError("RpcRequestError")<{
  readonly message: string;
  readonly method: string;
  readonly cause?: unknown;
}> {}

export class RpcConfig extends Context.Service<
  RpcConfig,
  {
    readonly rpcUrls: readonly string[];
  }
>()("typewriter/RpcConfig") {}

export class Rpc extends Context.Service<
  Rpc,
  {
    /**
     * Round-robins requests across the configured providers. Each attempt has
     * a {@link REQUEST_TIMEOUT} timeout and retries advance to the next
     * provider.
     */
    readonly request: EffectEip1193RequestFn<EIP1474Methods>;
    /**
     * Fans a request out to every configured provider concurrently, returning
     * the first non-error response. If every provider errors, the first
     * provider's error is returned. Does not retry.
     */
    readonly requestMultiplexed: EffectEip1193RequestFn<EIP1474Methods>;
  }
>()("typewriter/Rpc") {}

const REQUEST_TIMEOUT = Duration.seconds(5);
const RETRY_TIMES = 8;
const RETRY_DELAY = Duration.millis(200);

function encodeRequest(
  id: number,
  request: { method: string; params?: unknown },
) {
  const body: JsonRpcBody = {
    jsonrpc: "2.0",
    id,
    method: request.method,
  };
  if (request.params !== undefined) {
    return { ...body, params: request.params };
  }
  return body;
}

function decodeResponse<TResult>(
  body: JsonRpcBody,
  payload: JsonRpcResponse<TResult>,
): TResult {
  if (payload.error !== undefined) {
    throw new RpcRequestError({
      message: payload.error.message ?? `RPC request failed: ${body.method}`,
      method: body.method,
      cause: payload.error,
    });
  }
  return payload.result;
}

function makeRawHttpRequest(rpcUrl: string): RawRequest {
  let id = 0;

  return (request) => {
    const body = encodeRequest(++id, request);
    return Effect.tryPromise({
      try: async (signal) => {
        const response = await fetch(rpcUrl, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
          signal,
        });
        const text = await response.text();
        const payload = JSON.parse(text || "{}") as JsonRpcResponse<unknown>;

        if (!response.ok) {
          throw new RpcRequestError({
            message: `RPC HTTP ${response.status}: ${response.statusText}`,
            method: body.method,
            cause: payload,
          });
        }

        return decodeResponse(body, payload);
      },
      catch: (cause) => {
        if (cause instanceof RpcRequestError) {
          return cause;
        }
        return new RpcRequestError({
          message: `RPC request failed: ${body.method}`,
          method: body.method,
          cause,
        });
      },
    });
  };
}

function makeRpc(rpcUrls: readonly string[]): {
  request: EffectEip1193RequestFn<EIP1474Methods>;
  requestMultiplexed: EffectEip1193RequestFn<EIP1474Methods>;
} {
  const providers = rpcUrls.map(makeRawHttpRequest);

  const withTimeout = (
    effect: Effect.Effect<unknown, RpcRequestError>,
    method: string,
  ) =>
    effect.pipe(
      Effect.timeoutOrElse({
        duration: REQUEST_TIMEOUT,
        orElse: () =>
          Effect.fail(
            new RpcRequestError({
              message: `RPC request timed out after ${Duration.toMillis(
                REQUEST_TIMEOUT,
              )}ms: ${method}`,
              method,
            }),
          ),
      }),
    );

  // Round-robin cursor shared across requests; advanced once per attempt so
  // retries rotate onto the next provider.
  let cursor = 0;

  const request: RawRequest = (rpcRequest) => {
    const attempt = Effect.suspend(() => {
      const provider = providers[cursor % providers.length]!;
      cursor += 1;
      return withTimeout(provider(rpcRequest), rpcRequest.method);
    });
    return attempt.pipe(
      Effect.retry({
        times: RETRY_TIMES,
        schedule: Schedule.spaced(RETRY_DELAY),
      }),
    );
  };

  const requestMultiplexed: RawRequest = (rpcRequest) =>
    Effect.gen(function* () {
      const firstError = yield* Deferred.make<RpcRequestError>();
      const attempts = providers.map((provider, index) => {
        const attempt = withTimeout(provider(rpcRequest), rpcRequest.method);
        return index === 0
          ? attempt.pipe(
              Effect.tapError((error) => Deferred.succeed(firstError, error)),
            )
          : attempt;
      });
      return yield* Effect.raceAll(attempts).pipe(
        Effect.catch(() =>
          Deferred.await(firstError).pipe(
            Effect.flatMap((error) => Effect.fail(error)),
          ),
        ),
      );
    });

  return {
    request: request as EffectEip1193RequestFn<EIP1474Methods>,
    requestMultiplexed:
      requestMultiplexed as EffectEip1193RequestFn<EIP1474Methods>,
  };
}

export const layerRpc: Layer.Layer<Rpc, RpcConfigError, RpcConfig> =
  Layer.effect(
    Rpc,
    Effect.gen(function* () {
      const config = yield* RpcConfig;
      const { request, requestMultiplexed } = yield* Effect.try({
        try: () => {
          if (config.rpcUrls.length === 0) {
            throw new Error("at least one rpc url is required");
          }
          return makeRpc(config.rpcUrls);
        },
        catch: (cause) =>
          new RpcConfigError({
            message: "Failed to create RPC provider",
            cause,
          }),
      });
      return Rpc.of({ request, requestMultiplexed });
    }),
  );

export const layerRpcLive = (config: Context.Service.Shape<typeof RpcConfig>) =>
  layerRpc.pipe(Layer.provide(Layer.succeed(RpcConfig)(config)));
