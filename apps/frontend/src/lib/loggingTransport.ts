import { custom, http } from "viem";
import { CHAIN } from "../constants";
import { getCurrentScope } from "./rpcScope";
import { pushEntry } from "./rpcStore";

export function loggingTransport(url: string, options?: { silent?: string[] }) {
  const silentMethods = new Set(options?.silent);
  const httpTransport = http(url)({
    chain: CHAIN,
    retryCount: 0,
    timeout: 10_000,
  });

  return custom({
    async request({ method, params }) {
      const scope = getCurrentScope();
      if (scope?.silent || silentMethods.has(method)) {
        return httpTransport.request({ method, params });
      }
      const tag = scope?.tag ?? null;
      const start = performance.now();
      try {
        const result = await httpTransport.request({ method, params });
        pushEntry({
          method,
          tag,
          duration: performance.now() - start,
          status: "ok",
        });
        return result;
      } catch (err) {
        pushEntry({
          method,
          tag,
          duration: performance.now() - start,
          status: "error",
        });
        throw err;
      }
    },
  });
}
