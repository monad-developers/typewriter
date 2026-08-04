// Shared constants, EIP-712 types, and canvas math for the pixel war app. These
// values mirror `contracts/src/PixelWar.sol` — change both together.

export const WIDTH = 128;
export const HEIGHT = 128;
export const PIXEL_COUNT = WIDTH * HEIGHT;
export const PIXELS_PER_WORD = 64;
export const CANVAS_WORDS = PIXEL_COUNT / PIXELS_PER_WORD;

export const TEAM_COUNT = 4;
export const SHADES_PER_TEAM = 3;
export const COLOR_COUNT = TEAM_COUNT * SHADES_PER_TEAM;

export const ENERGY_PER_EPOCH = 30;
export const PAINT_COST = 1;
export const SHIELD_COST = 3;
export const BOMB_COST = 10;
export const MAX_SHIELD_STACK = 3;
export const BOMB_RADIUS = 1;

export const PERM_AUTHORIZE = 1 << 0;
export const PERM_REVOKE = 1 << 1;
export const PERM_PAINT = 1 << 2;
export const PERM_SHIELD = 1 << 3;
export const PERM_BOMB = 1 << 4;
export const PERM_ADVANCE_EPOCH = 1 << 5;

export const ALL_PERMISSIONS =
  PERM_AUTHORIZE |
  PERM_REVOKE |
  PERM_PAINT |
  PERM_SHIELD |
  PERM_BOMB |
  PERM_ADVANCE_EPOCH;

/// Session keys can play but cannot mint more keys, retire keys, or move the
/// epoch — those stay with the passkey and the server's own account.
export const SESSION_KEY_PERMISSIONS = PERM_PAINT | PERM_SHIELD | PERM_BOMB;

export type Team = {
  readonly id: number;
  readonly name: string;
  /// Palette entries for this team, darkest to lightest.
  readonly colors: readonly number[];
  /// Hex triples matching `colors`, used by both the canvas renderer and the UI.
  readonly hex: readonly string[];
};

export const TEAMS: readonly Team[] = [
  {
    id: 0,
    name: "Crimson",
    colors: [1, 2, 3],
    hex: ["#7f1d1d", "#dc2626", "#fca5a5"],
  },
  {
    id: 1,
    name: "Cobalt",
    colors: [4, 5, 6],
    hex: ["#1e3a8a", "#2563eb", "#93c5fd"],
  },
  {
    id: 2,
    name: "Moss",
    colors: [7, 8, 9],
    hex: ["#14532d", "#16a34a", "#86efac"],
  },
  {
    id: 3,
    name: "Amber",
    colors: [10, 11, 12],
    hex: ["#78350f", "#d97706", "#fcd34d"],
  },
];

export const EMPTY_HEX = "#0b0b0f";

/// Palette lookup indexed by color value; index 0 is bare canvas.
export const PALETTE: readonly string[] = [
  EMPTY_HEX,
  ...TEAMS.flatMap((team) => team.hex),
];

export function teamOfColor(color: number): number {
  if (color < 1 || color > COLOR_COUNT) {
    throw new Error(`color out of range: ${color}`);
  }
  return Math.floor((color - 1) / SHADES_PER_TEAM);
}

export function colorsForTeam(team: number): readonly number[] {
  const entry = TEAMS[team];
  if (entry === undefined) throw new Error(`team out of range: ${team}`);
  return entry.colors;
}

export function teamName(team: number): string {
  return TEAMS[team]?.name ?? `Team ${team}`;
}

export function toPixelIndex(x: number, y: number): number {
  return y * WIDTH + x;
}

export function wordOfPixel(index: number): number {
  return Math.floor(index / PIXELS_PER_WORD);
}

/// Unpacks one 256-bit canvas word into the 64 four-bit colors it holds.
export function unpackWord(word: bigint, into: Uint8Array, wordIndex: number) {
  const base = wordIndex * PIXELS_PER_WORD;
  for (let slot = 0; slot < PIXELS_PER_WORD; slot++) {
    into[base + slot] = Number((word >> BigInt(slot * 4)) & 0xfn);
  }
}

/// Pixels a bomb at (x, y) covers, clipped to the canvas the same way
/// `BombMutation.executeBomb` clips it.
export function bombFootprint(x: number, y: number): number[] {
  const pixels: number[] = [];
  const minX = Math.max(0, x - BOMB_RADIUS);
  const minY = Math.max(0, y - BOMB_RADIUS);
  const maxX = Math.min(WIDTH - 1, x + BOMB_RADIUS);
  const maxY = Math.min(HEIGHT - 1, y + BOMB_RADIUS);
  for (let py = minY; py <= maxY; py++) {
    for (let px = minX; px <= maxX; px++) {
      pixels.push(toPixelIndex(px, py));
    }
  }
  return pixels;
}

export const TOOLS = ["paint", "shield", "bomb"] as const;
export type Tool = (typeof TOOLS)[number];

export const TOOL_COST: Record<Tool, number> = {
  paint: PAINT_COST,
  shield: SHIELD_COST,
  bomb: BOMB_COST,
};

/// Mutation names in the order the server batches them. Every `Shield` in a tick
/// runs before every `Paint`, and every `Paint` before every `Bomb`.
export const PIXEL_WAR_BATCH_ORDER = [
  "Initialize",
  "Authorize",
  "Revoke",
  "AdvanceEpoch",
  "Shield",
  "Paint",
  "Bomb",
] as const;

export type MutationName = (typeof PIXEL_WAR_BATCH_ORDER)[number];

export const EIP712_TYPES = {
  Initialize: [
    { name: "account", type: "bytes32" },
    { name: "expiry", type: "uint40" },
    { name: "rootKeyType", type: "uint8" },
    { name: "keyType", type: "uint8" },
    { name: "permissions", type: "uint16" },
    { name: "rootPublicKey", type: "bytes" },
    { name: "publicKey", type: "bytes" },
  ],
  Authorize: [
    { name: "account", type: "bytes32" },
    { name: "expiry", type: "uint40" },
    { name: "keyType", type: "uint8" },
    { name: "permissions", type: "uint16" },
    { name: "publicKey", type: "bytes" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
  Revoke: [
    { name: "account", type: "bytes32" },
    { name: "keyId", type: "uint64" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
  AdvanceEpoch: [
    { name: "epoch", type: "uint64" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
  Shield: [
    { name: "x", type: "uint16" },
    { name: "y", type: "uint16" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
  Paint: [
    { name: "x", type: "uint16" },
    { name: "y", type: "uint16" },
    { name: "color", type: "uint8" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
  Bomb: [
    { name: "x", type: "uint16" },
    { name: "y", type: "uint16" },
    { name: "color", type: "uint8" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
} as const;

export const MAX_DEADLINE =
  0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffn;

/// A mutation's typed-data message, keyed by mutation name. `params` sent to the
/// server must carry exactly these fields in this order.
export function messageFor(
  name: MutationName,
  params: Record<string, unknown>,
): Record<string, unknown> {
  const fields = EIP712_TYPES[name];
  const message: Record<string, unknown> = {};
  for (const field of fields) {
    message[field.name] = params[field.name];
  }
  return message;
}
