import { custom, http } from "viem";
import { anvil } from "viem/chains";
import { pushEntry } from "./rpcStore";

export function loggingTransport(url: string) {
  const httpTransport = http(url)({
    chain: anvil,
    retryCount: 0,
    timeout: 10_000,
  });

  return custom({
    async request({ method, params }) {
      const start = performance.now();
      try {
        const result = await httpTransport.request({ method, params });
        pushEntry({
          method,
          duration: performance.now() - start,
          status: "ok",
        });
        return result;
      } catch (err) {
        pushEntry({
          method,
          duration: performance.now() - start,
          status: "error",
        });
        throw err;
      }
    },
  });
}
