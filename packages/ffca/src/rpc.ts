import { Context, Data, Effect, Layer } from "effect";
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
  args: parameters,
) => Effect.Effect<returnType, RpcRequestError>;

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
    readonly rpcUrl: string;
  }
>()("ffca/RpcConfig") {}

export class Rpc extends Context.Service<
  Rpc,
  {
    readonly request: EffectEip1193RequestFn<EIP1474Methods>;
  }
>()("ffca/Rpc") {}

function encodeRequest(id: number, args: { method: string; params?: unknown }) {
  const body: JsonRpcBody = {
    jsonrpc: "2.0",
    id,
    method: args.method,
  };
  if (args.params !== undefined) {
    return { ...body, params: args.params };
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

export function makeHttpRpcRequest(
  rpcUrl: string,
): EffectEip1193RequestFn<EIP1474Methods> {
  let id = 0;

  const request = (args: { method: string; params?: unknown }) => {
    const body = encodeRequest(++id, args);
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

  return request as EffectEip1193RequestFn<EIP1474Methods>;
}

export const layerRpc: Layer.Layer<Rpc, RpcConfigError, RpcConfig> =
  Layer.effect(
    Rpc,
    Effect.gen(function* () {
      const config = yield* RpcConfig;
      const request = yield* Effect.try({
        try: () => makeHttpRpcRequest(config.rpcUrl),
        catch: (cause) =>
          new RpcConfigError({
            message: "Failed to create RPC provider",
            cause,
          }),
      });
      return Rpc.of({ request });
    }),
  );

export const layerRpcLive = (config: Context.Service.Shape<typeof RpcConfig>) =>
  layerRpc.pipe(Layer.provide(Layer.succeed(RpcConfig)(config)));
