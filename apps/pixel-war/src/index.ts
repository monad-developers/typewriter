import { serve } from "bun";
import { drizzle } from "drizzle-orm/bun-sql/postgres";
import {
  BOMB_COST,
  BOMB_RADIUS,
  CANVAS_WORDS,
  ENERGY_PER_EPOCH,
  HEIGHT,
  MAX_SHIELD_STACK,
  PAINT_COST,
  PALETTE,
  PIXEL_COUNT,
  SESSION_KEY_PERMISSIONS,
  SHIELD_COST,
  TEAMS,
  WIDTH,
} from "pixel-war-sdk";
import superjson from "superjson";
import { createTypewriter, type MutationEvent } from "typewriter";
import type { Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import PixelWar from "../contracts/src/PixelWar.sol";
import index from "../frontend/index.html";
import {
  EPOCH_NONCE_LANE,
  initializeMutation,
  MAX_DEADLINE,
  nonceFor,
  normalizeSignatureForContract,
  PIXEL_WAR_BATCH_ORDER,
  type PixelWarSignature,
  secp256k1AccountId,
  signMutation,
} from "./app";
import { Canvas, type StateReader } from "./canvas";
import {
  CANVAS_FLUSH_MS,
  CHAIN,
  EPOCH_INTERVAL_MS,
  PIXEL_WAR_ADDRESS,
  RATE_LIMIT_BURST,
  RATE_LIMIT_PER_SECOND,
  RPC_URLS,
} from "./constants";
import {
  selectLeaderboard,
  selectMutationById,
  selectMutationsByAccount,
  selectPixelHistory,
  selectRecentActions,
  selectRecentMutationCount,
} from "./db-queries";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") {
    throw new Error(`${name} env var is required`);
  }
  return value;
}

const FORCE_INCLUSION_DELAY = 658;
const ACTIVITY_FLUSH_MS = 100;
const ACTIVITY_BATCH_LIMIT = 24;
const ACCOUNT_HISTORY_LIMIT = 40;
const TPS_WINDOW_MS = 10_000;

const scheduler = privateKeyToAccount(requireEnv("PRIVATE_KEY") as Hex);
const databaseUrl = requireEnv("DATABASE_URL");

const app = await createTypewriter(PixelWar, {
  address: PIXEL_WAR_ADDRESS,
  account: scheduler,
  chainId: CHAIN.id,
  rpcUrl: RPC_URLS,
  database: { url: databaseUrl, maxConnections: 25 },
  sequencing: {
    order: "batch",
    batchOrder: PIXEL_WAR_BATCH_ORDER,
  },
});

const readerDb = drizzle({
  client: new Bun.SQL({ url: databaseUrl, max: 25 }),
});

const canvas = new Canvas(app.state as unknown as StateReader);
await canvas.load();

// ---------------------------------------------------------------------------
// Server-sent events
// ---------------------------------------------------------------------------

type Channel = "canvas" | "activity" | "blocks";

const subscribers: Record<Channel, Set<(chunk: string) => void>> = {
  canvas: new Set(),
  activity: new Set(),
  blocks: new Set(),
};

function broadcast(channel: Channel, event: string, value: unknown): void {
  if (subscribers[channel].size === 0) return;
  const chunk = `event: ${event}\ndata: ${JSON.stringify(value)}\n\n`;
  for (const send of subscribers[channel]) send(chunk);
}

function eventStream(channel: Channel): Response {
  const encoder = new TextEncoder();
  let send: (chunk: string) => void = () => {};
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      send = (chunk) => {
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          subscribers[channel].delete(send);
        }
      };
      subscribers[channel].add(send);
      send(`event: open\ndata: {}\n\n`);
    },
    cancel() {
      subscribers[channel].delete(send);
    },
  });
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}

// ---------------------------------------------------------------------------
// Canvas mirror
// ---------------------------------------------------------------------------

app.on("mutation", (mutation) => {
  if (mutation.status !== "accepted") return;
  canvas.touch({
    name: mutation.name,
    params: mutation.params as Record<string, unknown>,
  });
});

setInterval(async () => {
  try {
    const flush = await canvas.flush();
    if (flush === null) return;
    // Pixel deltas ride the wire as a flat [index, color, ...] pair list.
    broadcast("canvas", "canvas", {
      epoch: flush.epoch,
      teamPixels: flush.teamPixels,
      pixels: flush.pixels.flatMap((pixel) => [pixel.index, pixel.color]),
      shields: flush.shields.flatMap((shield) => [
        shield.index,
        shield.charges,
      ]),
      epochStartedAt,
    });
  } catch (error) {
    console.error("canvas flush failed", error);
  }
}, CANVAS_FLUSH_MS);

// ---------------------------------------------------------------------------
// Activity feed
// ---------------------------------------------------------------------------

type ActivityEvent = {
  id: number;
  name: string;
  status: string;
  account: Hex | null;
  x: number | null;
  y: number | null;
  color: number | null;
  isForceInclusion: boolean;
};

let activityBuffer = new Map<number, ActivityEvent>();
let activityDropped = 0;

function activityFrom(mutation: MutationEvent): ActivityEvent {
  const params = mutation.params as Record<string, unknown>;
  const signature = mutation.signature as Partial<PixelWarSignature>;
  const numberOrNull = (value: unknown) =>
    value === undefined || value === null ? null : Number(value);
  return {
    id: mutation.id,
    name: mutation.name,
    status: mutation.status,
    account: signature.account ?? null,
    x: numberOrNull(params.x),
    y: numberOrNull(params.y),
    color: numberOrNull(params.color),
    isForceInclusion:
      "isForceInclusion" in mutation
        ? mutation.isForceInclusion === true
        : false,
  };
}

app.on("mutation", (mutation) => {
  if (activityBuffer.size >= ACTIVITY_BATCH_LIMIT * 4) {
    activityDropped++;
    return;
  }
  activityBuffer.set(mutation.id, activityFrom(mutation));
});

setInterval(() => {
  if (activityBuffer.size === 0 && activityDropped === 0) return;
  const events = [...activityBuffer.values()]
    .sort((a, b) => b.id - a.id)
    .slice(0, ACTIVITY_BATCH_LIMIT);
  const dropped = activityDropped;
  activityBuffer = new Map();
  activityDropped = 0;
  broadcast("activity", "activity", { events, dropped });
}, ACTIVITY_FLUSH_MS);

app.on("block", (block) => {
  const mutations =
    "mutations" in block && Array.isArray(block.mutations)
      ? block.mutations.length
      : "batches" in block && Array.isArray(block.batches)
        ? block.batches.reduce(
            (total, batch) => total + batch.mutations.length,
            0,
          )
        : 0;
  broadcast("blocks", "block", {
    status: block.status,
    number: String(block.number),
    timestamp: String(block.timestamp),
    transactionHash: block.transactionHash,
    batches:
      "batches" in block && Array.isArray(block.batches)
        ? block.batches.length
        : 0,
    mutations,
  });
});

// ---------------------------------------------------------------------------
// Epoch clock
// ---------------------------------------------------------------------------

const systemAccountId = secp256k1AccountId(scheduler.address);
let epochStartedAt = Date.now();
let epochSeq = 0n;

/// The epoch authority is a normal app account whose key happens to live on the
/// server. It has to be registered before it can sign anything, and doing that
/// here means a fresh deployment needs no extra setup step.
async function bootstrapEpochAuthority(): Promise<void> {
  const keyCount = await app.state.accounts[systemAccountId].keys.length;
  if (keyCount === 0) {
    await app.execute(
      initializeMutation(scheduler.address) as Parameters<
        typeof app.execute
      >[0],
    );
    console.log(`registered epoch authority ${systemAccountId}`);
  }
  epochSeq = BigInt(
    await app.state.accounts[systemAccountId].nonces[
      String(EPOCH_NONCE_LANE) as `${number}`
    ],
  );
}

async function advanceEpoch(): Promise<void> {
  const current = Number(await app.state.epoch);
  const signed = await signMutation({
    name: "AdvanceEpoch",
    params: {
      epoch: BigInt(current + 1),
      nonce: nonceFor(EPOCH_NONCE_LANE, epochSeq),
      deadline: MAX_DEADLINE,
    },
    account: scheduler,
    signerAccountId: systemAccountId,
    keyId: 1n,
    contract: PIXEL_WAR_ADDRESS,
    chainId: CHAIN.id,
  });
  await app.execute(signed as Parameters<typeof app.execute>[0]);
  epochSeq += 1n;
  epochStartedAt = Date.now();
}

await bootstrapEpochAuthority();

setInterval(async () => {
  try {
    await advanceEpoch();
  } catch (error) {
    console.error("epoch advance failed", error);
    // Re-read the lane so a rejected advance cannot wedge the clock.
    try {
      epochSeq = BigInt(
        await app.state.accounts[systemAccountId].nonces[
          String(EPOCH_NONCE_LANE) as `${number}`
        ],
      );
    } catch (nonceError) {
      console.error("epoch nonce re-read failed", nonceError);
    }
  }
}, EPOCH_INTERVAL_MS);

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

function json(value: unknown, init?: ResponseInit): Response {
  return new Response(superjson.stringify(value), {
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers },
  });
}

async function accountView(account: Hex) {
  const stored = app.state.accounts[account];
  const keyCount = await stored.keys.length;
  if (keyCount === 0) return null;

  const [epoch, energy, painted, team, stateEpoch] = await Promise.all([
    stored.epoch,
    stored.energy,
    stored.painted,
    stored.team,
    app.state.epoch,
  ]);

  const keys: {
    keyId: number;
    expiry: number;
    keyType: number;
    permissions: number;
    publicKey: Hex;
  }[] = [];
  for (let keyId = 0; keyId < keyCount; keyId++) {
    const key = stored.keys[keyId];
    const [expiry, keyType, permissions, publicKey] = await Promise.all([
      key.expiry,
      key.keyType,
      key.permissions,
      key.publicKey,
    ]);
    keys.push({
      keyId,
      expiry: Number(expiry),
      keyType: Number(keyType),
      permissions: Number(permissions),
      publicKey: publicKey as Hex,
    });
  }

  // Energy refills lazily on the account's first action in a new epoch, so a
  // stale epoch means a full bar even though storage still holds the old value.
  const currentEpoch = Number(stateEpoch);
  const effectiveEnergy =
    Number(epoch) === currentEpoch ? Number(energy) : ENERGY_PER_EPOCH;

  return {
    account,
    team: Number(team),
    epoch: currentEpoch,
    energy: effectiveEnergy,
    maxEnergy: ENERGY_PER_EPOCH,
    painted: Number(painted),
    keys,
  };
}

function canvasSnapshotBody() {
  const snapshot = canvas.snapshot();
  return {
    epoch: snapshot.epoch,
    teamPixels: snapshot.teamPixels,
    epochStartedAt,
    colors: Buffer.from(snapshot.colors).toString("base64"),
    shields: Buffer.from(snapshot.shields).toString("base64"),
  };
}

// ---------------------------------------------------------------------------
// Rate limiting
// ---------------------------------------------------------------------------

type Bucket = { tokens: number; updatedAt: number };
const buckets = new Map<string, Bucket>();

function allowRequest(key: string): boolean {
  const now = Date.now();
  const bucket = buckets.get(key) ?? {
    tokens: RATE_LIMIT_BURST,
    updatedAt: now,
  };
  const refill = ((now - bucket.updatedAt) / 1000) * RATE_LIMIT_PER_SECOND;
  bucket.tokens = Math.min(RATE_LIMIT_BURST, bucket.tokens + refill);
  bucket.updatedAt = now;
  if (bucket.tokens < 1) {
    buckets.set(key, bucket);
    return false;
  }
  bucket.tokens -= 1;
  buckets.set(key, bucket);
  return true;
}

// Buckets are only interesting while they are below full.
setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of buckets) {
    if (now - bucket.updatedAt > 60_000) buckets.delete(key);
  }
}, 60_000);

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

const server = serve({
  idleTimeout: 0,
  routes: {
    "/api/domain": () => json(app.domain),

    "/api/config": () =>
      json({
        width: WIDTH,
        height: HEIGHT,
        pixelCount: PIXEL_COUNT,
        canvasWords: CANVAS_WORDS,
        palette: PALETTE,
        teams: TEAMS,
        costs: { paint: PAINT_COST, shield: SHIELD_COST, bomb: BOMB_COST },
        energyPerEpoch: ENERGY_PER_EPOCH,
        maxShieldStack: MAX_SHIELD_STACK,
        bombRadius: BOMB_RADIUS,
        sessionKeyPermissions: SESSION_KEY_PERMISSIONS,
        epochIntervalMs: EPOCH_INTERVAL_MS,
        batchOrder: PIXEL_WAR_BATCH_ORDER,
        forceInclusionDelay: FORCE_INCLUSION_DELAY,
        contract: PIXEL_WAR_ADDRESS,
        chainId: CHAIN.id,
        explorer: CHAIN.blockExplorers?.default.url ?? null,
      }),

    "/api/canvas": () => json(canvasSnapshotBody()),

    "/api/state": async () =>
      json({
        epoch: canvas.epoch,
        epochStartedAt,
        epochIntervalMs: EPOCH_INTERVAL_MS,
        teamPixels: canvas.teamPixels,
        pixelCount: PIXEL_COUNT,
        tps:
          (await selectRecentMutationCount(
            readerDb,
            app.schema,
            TPS_WINDOW_MS,
          )) /
          (TPS_WINDOW_MS / 1000),
      }),

    "/api/events/canvas": () => eventStream("canvas"),
    "/api/events/activity": () => eventStream("activity"),
    "/api/events/blocks": () => eventStream("blocks"),

    "/api/tps": async () =>
      json(
        (await selectRecentMutationCount(readerDb, app.schema, TPS_WINDOW_MS)) /
          (TPS_WINDOW_MS / 1000),
      ),

    "/api/activity": async () =>
      json(await selectRecentActions(readerDb, app.schema, 40)),

    "/api/leaderboard": async () =>
      json(await selectLeaderboard(readerDb, app.schema, 20)),

    "/api/pixel/:x/:y": async (req) => {
      const x = Number(req.params.x);
      const y = Number(req.params.y);
      if (
        !Number.isInteger(x) ||
        !Number.isInteger(y) ||
        x < 0 ||
        y < 0 ||
        x >= WIDTH ||
        y >= HEIGHT
      ) {
        return json({ error: "pixel out of bounds" }, { status: 400 });
      }
      const index = y * WIDTH + x;
      return json({
        x,
        y,
        color: canvas.colors[index] ?? 0,
        shields: canvas.shields[index] ?? 0,
        history: await selectPixelHistory(readerDb, app.schema, x, y, 10),
      });
    },

    "/api/account/:id": async (req) => {
      const account = req.params.id as Hex;
      if (!/^0x[0-9a-fA-F]{64}$/.test(account)) {
        return json({ error: "invalid account id" }, { status: 400 });
      }
      const view = await accountView(account);
      if (view === null) {
        return json({ error: "account not found" }, { status: 404 });
      }
      return json({
        ...view,
        mutations: await selectMutationsByAccount(
          readerDb,
          app.schema,
          account,
          ACCOUNT_HISTORY_LIMIT,
        ),
      });
    },

    "/api/account/:id/exists": async (req) => {
      const account = req.params.id as Hex;
      if (!/^0x[0-9a-fA-F]{64}$/.test(account)) {
        return json({ exists: false });
      }
      const keyCount = await app.state.accounts[account].keys.length;
      return json({ exists: keyCount > 0, keys: keyCount });
    },

    "/api/mutation": async (req) => {
      const id = new URL(req.url).searchParams.get("id");
      if (id === null || !/^\d+$/.test(id)) {
        return json({ error: "id query parameter required" }, { status: 400 });
      }
      const mutation = await selectMutationById(
        readerDb,
        app.schema,
        Number(id),
      );
      if (mutation === null) {
        return json({ error: "mutation not found" }, { status: 404 });
      }
      return json(mutation);
    },

    "/api": {
      POST: async (req) => {
        const address = server.requestIP(req)?.address ?? "unknown";
        if (!allowRequest(address)) {
          return json({ error: "rate limited" }, { status: 429 });
        }

        const parsed = superjson.parse(await req.text());
        const body =
          parsed !== null && typeof parsed === "object"
            ? (parsed as Record<string, unknown>)
            : {};
        if (
          typeof body.name !== "string" ||
          body.params === undefined ||
          body.signature === undefined
        ) {
          return json(
            { error: "name, params and signature required" },
            {
              status: 400,
            },
          );
        }

        try {
          const result = await app.execute({
            name: body.name,
            params: body.params,
            signature: normalizeSignatureForContract(
              body.signature as PixelWarSignature,
            ),
          } as Parameters<typeof app.execute>[0]);
          return json({ id: result.id, status: "accepted" });
        } catch (error) {
          // A rejected mutation is a normal outcome here — out of energy, wrong
          // team color, stale nonce — so it is a 400, not a server fault.
          return json(
            { error: error instanceof Error ? error.message : String(error) },
            { status: 400 },
          );
        }
      },
    },

    "/*": index,
  },
  development: process.env.NODE_ENV !== "production" && {
    hmr: true,
    console: true,
  },
});

console.log(`pixel war listening on ${server.url}`);
console.log(`contract ${PIXEL_WAR_ADDRESS} on chain ${CHAIN.id}`);
