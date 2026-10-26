import { Data, Effect } from "effect";
import type { EIP1193Parameters, PublicRpcSchema, WalletRpcSchema } from "viem";

type RpcSchema = [...PublicRpcSchema, ...WalletRpcSchema];

export type RpcRequest = EIP1193Parameters<RpcSchema>;

export type RpcMethod = RpcRequest["method"];

export type RpcResult<method extends RpcMethod> = Extract<
  RpcSchema[number],
  { Method: method }
>["ReturnType"];

/**
 * Sends one JSON-RPC request to one provider. A transport does not time out,
 * retry, or select a provider. Interrupting the returned effect aborts the
 * in-flight HTTP request.
 */
export type RpcTransport = {
  origin: string;
  request: <request extends RpcRequest>(
    request: request,
  ) => Effect.Effect<RpcResult<request["method"]>, RpcTransportError>;
};

/** The request did not get an HTTP response (DNS, connection, TLS, reset). */
export class RpcNetworkError extends Data.TaggedError("RpcNetworkError")<{
  method: RpcMethod;
  origin: string;
  cause: unknown;
}> {
  override get message() {
    return `Failed '${this.method}' request to ${this.origin}`;
  }
}

/**
 * The provider replied, but not with a JSON-RPC result or error for the
 * request: a non-2xx status, a body that is not JSON, or a wrong id.
 */
export class RpcHttpError extends Data.TaggedError("RpcHttpError")<{
  method: RpcMethod;
  origin: string;
  status: number;
  body: string;
  cause?: unknown;
}> {
  override get message() {
    const body =
      this.body.length > 200 ? `${this.body.slice(0, 200)}...` : this.body;
    return `Failed '${this.method}' request to ${this.origin} with HTTP ${this.status}${body === "" ? "" : `: ${body}`}`;
  }
}

/** The provider replied with a JSON-RPC error object. */
export class RpcResponseError extends Data.TaggedError("RpcResponseError")<{
  method: RpcMethod;
  origin: string;
  status: number;
  error: { code: number; message: unknown; data?: unknown };
}> {
  override get message() {
    return `Failed '${this.method}' request to ${this.origin}: ${String(this.error.message)} (code ${this.error.code})`;
  }
}

export type RpcTransportError =
  | RpcNetworkError
  | RpcHttpError
  | RpcResponseError;

export function makeHttpTransport(url: string): RpcTransport {
  const origin = new URL(url).origin;
  let id = 0;

  const request = ({ method, params }: RpcRequest) =>
    Effect.gen(function* () {
      // `JSON.stringify` drops `params` when it is `undefined`.
      const body = { jsonrpc: "2.0", id: ++id, method, params };

      const { response, text } = yield* Effect.tryPromise({
        try: async (signal) => {
          const response = await fetch(url, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
            signal,
          });
          return { response, text: await response.text() };
        },
        catch: (cause) => new RpcNetworkError({ method, origin, cause }),
      });

      let payload: {
        id?: unknown;
        result?: unknown;
        error?: { code?: unknown; message?: unknown; data?: unknown };
      } | null = null;
      let cause: unknown;
      try {
        payload = JSON.parse(text);
      } catch (error) {
        cause = error;
      }

      // A JSON-RPC error takes priority over the HTTP status. The id can be
      // `null` when the provider could not read the request id.
      const error = payload?.error;
      if (
        (payload?.id === body.id || payload?.id === null) &&
        typeof error?.code === "number"
      ) {
        return yield* new RpcResponseError({
          method,
          origin,
          status: response.status,
          error: {
            code: error.code,
            message: error.message,
            data: error.data,
          },
        });
      }

      // `result` can be `null` (for example, an unknown block), so check for
      // the key and not for the value.
      if (response.ok && payload?.id === body.id && "result" in payload) {
        return payload.result;
      }

      return yield* new RpcHttpError({
        method,
        origin,
        status: response.status,
        body: text,
        cause,
      });
    });

  return { origin, request: request as RpcTransport["request"] };
}
