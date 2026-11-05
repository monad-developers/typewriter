import { privateKeyToAccount } from "viem/accounts";
import { ASSESSMENT_ENTRYPOINT } from "../simulation-test/assessment-constants";
import type { Plan } from "../simulation-test/plan";
import { createTypewriter } from "../src";

const { port, plan, address, privateKey, chainId, rpcUrls, databaseUrl } =
  // biome-ignore lint/complexity/useLiteralKeys: `process.env` has an index signature.
  JSON.parse(process.env["BENCHMARK_CONFIG"]!) as {
    port: number;
    plan: Plan;
    address: `0x${string}`;
    privateKey: `0x${string}`;
    chainId: number;
    rpcUrls: [string, ...string[]];
    databaseUrl: string;
  };

const typewriter = await createTypewriter(ASSESSMENT_ENTRYPOINT, {
  address,
  account: privateKeyToAccount(privateKey),
  chainId,
  hardfork: "MonadTen",
  rpcUrl: rpcUrls,
  database: { url: databaseUrl },
  blockPollingIntervalMs: plan.typewriter.blockPollingIntervalMs,
  sequencing: plan.typewriter.ordering,
});

let included = 0;
typewriter.on("mutation", ({ status }) => {
  if (status === "included") included++;
});

Bun.serve({
  port,
  routes: {
    "/included": () => Response.json(included),
    "/execute": {
      POST: async (req) => {
        const mutation = await req.json();
        const start = performance.now();
        const error = await typewriter
          .execute(mutation as Parameters<typeof typewriter.execute>[0])
          .then(
            () => undefined,
            (error: Error) => error.name,
          );
        return Response.json({ ms: performance.now() - start, error });
      },
    },
  },
});
