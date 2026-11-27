import { privateKeyToAccount } from "viem/accounts";
import { ASSESSMENT_ENTRYPOINT } from "../simulation-test/assessment-constants";
import type { Plan } from "../simulation-test/plan";
import { createTypewriter } from "../src";

const { port, plan, privateKey, chainId, rpcUrls, databaseUrl } =
  // biome-ignore lint/complexity/useLiteralKeys: `process.env` has an index signature.
  JSON.parse(process.env["BENCHMARK_CONFIG"]!) as {
    port: number;
    plan: Plan;
    privateKey: `0x${string}`;
    chainId: number;
    rpcUrls: [string, ...string[]];
    databaseUrl: string;
  };

const typewriter = await createTypewriter(ASSESSMENT_ENTRYPOINT, {
  root: privateKeyToAccount(privateKey).address,
  scheduler: privateKeyToAccount(privateKey),
  chainId,
  hardfork: "MonadTen",
  rpcUrl: rpcUrls,
  deployment: "typewriter_benchmark",
  database: { url: databaseUrl },
  blockPollingIntervalMs: plan.typewriter.blockPollingIntervalMs,
  sequencing: plan.typewriter.ordering,
});

let included = 0;
const acceptedAt = new Map<bigint, number>();
const inclusionMs: number[] = [];
typewriter.on("mutation", (event) => {
  if (event.status === "accepted") {
    acceptedAt.set(event.executionIndex, performance.now());
  } else if (event.status === "included") {
    included++;
    inclusionMs.push(performance.now() - acceptedAt.get(event.executionIndex)!);
  }
});

Bun.serve({
  port,
  routes: {
    "/manifest": () => Response.json(typewriter.manifest),
    "/included": () => Response.json(included),
    "/inclusion": () => Response.json(inclusionMs),
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
