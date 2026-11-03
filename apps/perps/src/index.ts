import { serve } from "bun";
import superjson from "superjson";
import type { Hex } from "viem";
import { admin, bootstrapAdmin } from "./admin";
import { app, dev } from "./app";
import { startFunding } from "./funding";
import { recentLiquidations, startLiquidator } from "./liquidator";
import { startMarketMaker } from "./market-maker";
import { listMarkets } from "./markets";
import { setOraclePrice, startOracle } from "./oracle";
import {
  accountExists,
  accountSummary,
  exchangeSummary,
  levels,
  marketExists,
  marketSummary,
} from "./read";

const ORACLE_INTERVAL_MS = Number(process.env.ORACLE_INTERVAL_MS ?? 1_000);
const FUNDING_INTERVAL_MS = Number(process.env.FUNDING_INTERVAL_MS ?? 10_000);
const MARKET_MAKER_INTERVAL_MS = 2_000;

await bootstrapAdmin();
await listMarkets();
startLiquidator();
if (dev && process.env.MARKET_MAKER !== "false") {
  await startMarketMaker(MARKET_MAKER_INTERVAL_MS);
}
if (ORACLE_INTERVAL_MS > 0) startOracle(ORACLE_INTERVAL_MS);
if (FUNDING_INTERVAL_MS > 0) startFunding(FUNDING_INTERVAL_MS);

function json(value: unknown, init?: ResponseInit): Response {
  return new Response(superjson.stringify(value), {
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers },
  });
}

function badRequest(error: string): Response {
  return json({ error }, { status: 400 });
}

function notFound(error: string): Response {
  return json({ error }, { status: 404 });
}

function intParam(value: string | undefined | null): bigint | undefined {
  return value != null && /^\d+$/.test(value) ? BigInt(value) : undefined;
}

function isAccountID(value: unknown): value is Hex {
  return typeof value === "string" && /^0x[0-9a-fA-F]{64}$/.test(value);
}

async function body(req: Request): Promise<Record<string, unknown>> {
  const parsed = superjson.parse(await req.text());
  return parsed !== null && typeof parsed === "object"
    ? (parsed as Record<string, unknown>)
    : {};
}

/** Runs an execute, turning a rejected mutation into a 400. */
async function accepted(execute: () => Promise<{ executionIndex: bigint }>) {
  try {
    const { executionIndex } = await execute();
    return json({ executionIndex, status: "accepted" });
  } catch (error) {
    return badRequest(error instanceof Error ? error.message : String(error));
  }
}

const devRoutes = {
  // Credits collateral, standing in for a bridge that attests deposits.
  "/api/dev/faucet": {
    POST: async (req: Request) => {
      if (!dev) return notFound("dev only");
      const { account, amount } = await body(req);
      if (!isAccountID(account) || typeof amount !== "bigint") {
        return badRequest("account and amount (bigint) required");
      }
      return accepted(() => admin.execute("Deposit", { account, amount }));
    },
  },
  "/api/dev/oracle": {
    POST: async (req: Request) => {
      if (!dev) return notFound("dev only");
      const { marketId, price } = await body(req);
      if (typeof marketId !== "bigint" || typeof price !== "bigint") {
        return badRequest("marketId and price (bigint) required");
      }
      return accepted(() => setOraclePrice(marketId, price));
    },
  },
};

const server = serve({
  port: Number(process.env.PORT ?? 3000),
  routes: {
    "/api/manifest": () => json(app.manifest),
    "/api": {
      POST: async (req) => {
        const submitted = await body(req);
        if (
          typeof submitted.name !== "string" ||
          submitted.params === undefined ||
          submitted.authorization === undefined
        ) {
          return badRequest("name, params, and authorization required");
        }
        return accepted(() =>
          app.execute(submitted as Parameters<typeof app.execute>[0]),
        );
      },
    },
    "/api/exchange": () => json(exchangeSummary()),
    "/api/markets/:id": (req) => {
      const marketId = intParam(req.params.id);
      if (marketId === undefined) return badRequest("Invalid market ID");
      if (!marketExists(marketId)) return notFound("market not found");
      const depth = intParam(new URL(req.url).searchParams.get("depth"));
      const limit = depth === undefined ? 20 : Number(depth);
      return json({
        ...marketSummary(marketId),
        bids: levels(marketId, "buy", limit),
        asks: levels(marketId, "sell", limit),
      });
    },
    "/api/accounts/:id": (req) => {
      const account = req.params.id;
      if (!isAccountID(account)) return badRequest("Invalid account ID");
      if (!accountExists(account)) return notFound("account not found");
      return json(accountSummary(account));
    },
    "/api/liquidations": () => json(recentLiquidations()),
    ...devRoutes,
  },
});

console.log(`perps listening on ${server.url}`);
