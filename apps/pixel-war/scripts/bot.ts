/**
 * A player that paints on its own. Useful for keeping a public demo alive, for
 * eyeballing throughput, and for producing the shield/paint/bomb races that the
 * batch order resolves.
 *
 * Usage, from apps/pixel-war:
 *   API_URL=http://localhost:3000 BOT_KEY=0x... bun run bot
 *
 * Optional: INTERVAL_MS, SHAPE (blob|scatter|stripe), BOT_TOOL (paint|shield|bomb|mix)
 */
import {
  colorsForTeam,
  HEIGHT,
  MAX_DEADLINE,
  messageFor,
  type Tool,
  WIDTH,
} from "pixel-war-sdk";
import superjson from "superjson";
import { type Address, bytesToHex, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  initializeMutation,
  nonceFor,
  type SubmittedPixelWarMutation,
  secp256k1AccountId,
  signMutation,
} from "../src/app";

const API_URL = process.env.API_URL ?? "http://localhost:3000";
const INTERVAL_MS = Number(process.env.INTERVAL_MS ?? 400);
const SHAPE = process.env.SHAPE ?? "blob";
const BOT_TOOL = process.env.BOT_TOOL ?? "mix";

if (process.env.BOT_KEY === undefined) {
  throw new Error("BOT_KEY env var is required (any 32-byte hex private key)");
}
const account = privateKeyToAccount(process.env.BOT_KEY as Hex);
const accountId = secp256k1AccountId(account.address);

async function get<T>(path: string): Promise<{ status: number; data: T }> {
  const res = await fetch(`${API_URL}${path}`);
  const text = await res.text();
  return {
    status: res.status,
    data: (text === "" ? undefined : superjson.parse(text)) as T,
  };
}

async function post(body: unknown): Promise<void> {
  const res = await fetch(`${API_URL}/api`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: superjson.stringify(body),
  });
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
}

const { data: config } = await get<{ contract: Address; chainId: number }>(
  "/api/config",
);

async function ensureRegistered(): Promise<number> {
  const existing = await get<{ team: number }>(`/api/account/${accountId}`);
  if (existing.status === 404) {
    await post(initializeMutation(account.address));
    console.log(`registered ${accountId}`);
  }
  const { data } = await get<{ team: number }>(`/api/account/${accountId}`);
  return data.team;
}

const team = await ensureRegistered();
const colors = colorsForTeam(team);
console.log(`bot ${accountId} on team ${team}, acting every ${INTERVAL_MS}ms`);

// A random lane per run keeps this bot's nonces independent of every other
// player, so nothing serializes behind anything else.
const lane = BigInt(bytesToHex(crypto.getRandomValues(new Uint8Array(24))));
let seq = 0n;

let step = 0;
const home = {
  x: Math.floor(Math.random() * WIDTH),
  y: Math.floor(Math.random() * HEIGHT),
};

function nextTarget(): { x: number; y: number } {
  step++;
  if (SHAPE === "scatter") {
    return {
      x: Math.floor(Math.random() * WIDTH),
      y: Math.floor(Math.random() * HEIGHT),
    };
  }
  if (SHAPE === "stripe") {
    return {
      x: step % WIDTH,
      y: (home.y + Math.floor(step / WIDTH)) % HEIGHT,
    };
  }
  // blob: a random walk around a home pixel.
  const radius = 6;
  const clamp = (value: number, max: number) =>
    Math.min(max - 1, Math.max(0, value));
  return {
    x: clamp(home.x + Math.floor((Math.random() - 0.5) * radius * 2), WIDTH),
    y: clamp(home.y + Math.floor((Math.random() - 0.5) * radius * 2), HEIGHT),
  };
}

function nextTool(): Tool {
  if (BOT_TOOL !== "mix") return BOT_TOOL as Tool;
  const roll = Math.random();
  if (roll > 0.94) return "bomb";
  if (roll > 0.82) return "shield";
  return "paint";
}

const NAME_FOR_TOOL = {
  paint: "Paint",
  shield: "Shield",
  bomb: "Bomb",
} as const;

let accepted = 0;
let rejected = 0;

async function act(): Promise<void> {
  const name = NAME_FOR_TOOL[nextTool()];
  const target = nextTarget();
  const params: Record<string, unknown> = {
    x: target.x,
    y: target.y,
    nonce: nonceFor(lane, seq),
    deadline: MAX_DEADLINE,
  };
  if (name !== "Shield") {
    params.color = colors[Math.floor(Math.random() * colors.length)]!;
  }

  const signed = (await signMutation({
    name,
    params: messageFor(name, params),
    account,
    signerAccountId: accountId,
    keyId: 1n,
    contract: config.contract,
    chainId: config.chainId,
  })) as SubmittedPixelWarMutation;

  try {
    await post(signed);
    seq++;
    accepted++;
  } catch (error) {
    // Out of energy, or shielding a pixel the team does not hold: expected play,
    // not a fault. A rejected mutation never consumes its nonce.
    rejected++;
    if (rejected % 20 === 1) {
      console.log(
        `rejected (${rejected} total): ${String(error).slice(0, 140)}`,
      );
    }
  }
}

setInterval(() => {
  void act();
}, INTERVAL_MS);

setInterval(() => {
  console.log(`accepted ${accepted} · rejected ${rejected}`);
}, 10_000);
