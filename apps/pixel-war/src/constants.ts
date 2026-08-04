import type { Address } from "viem";
import { extractChain } from "viem";
import { anvil, monadTestnet } from "viem/chains";

const chains = [anvil, monadTestnet] as const;

if (!process.env.CHAIN_ID) throw new Error("CHAIN_ID env var is required");
export const CHAIN_ID = Number(process.env.CHAIN_ID);

export const CHAIN = extractChain({
  chains,
  id: CHAIN_ID as (typeof chains)[number]["id"],
}) as typeof anvil | typeof monadTestnet;

if (!process.env.RPC_URL) throw new Error("RPC_URL env var is required");
export const RPC_URLS = process.env.RPC_URL.split(",")
  .map((url) => url.trim())
  .filter((url) => url.length > 0);
if (RPC_URLS.length === 0)
  throw new Error("RPC_URL must contain at least one URL");
export const RPC_URL = RPC_URLS[0]!;

if (!process.env.PIXEL_WAR_ADDRESS)
  throw new Error("PIXEL_WAR_ADDRESS env var is required");
export const PIXEL_WAR_ADDRESS = process.env.PIXEL_WAR_ADDRESS as Address;

/// How often the server signs an `AdvanceEpoch` mutation. Every account's energy
/// refills on its first action in a new epoch, so this is the game's clock.
export const EPOCH_INTERVAL_MS = Number(
  process.env.EPOCH_INTERVAL_MS ?? 10_000,
);

/// How often the canvas mirror re-reads dirty words and pushes deltas to
/// connected clients.
export const CANVAS_FLUSH_MS = Number(process.env.CANVAS_FLUSH_MS ?? 50);

/// Sponsored gas means an abusive client spends the server's money, so mutation
/// submissions are also rate limited per IP. The contract's per-epoch energy cap
/// is the durable limit; this just keeps one host from monopolising the queue.
export const RATE_LIMIT_PER_SECOND = Number(
  process.env.RATE_LIMIT_PER_SECOND ?? 25,
);
export const RATE_LIMIT_BURST = Number(process.env.RATE_LIMIT_BURST ?? 60);
