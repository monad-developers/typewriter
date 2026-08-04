import { and, count, desc, eq, gte, lte } from "drizzle-orm";
import type { BunSQLDatabase } from "drizzle-orm/bun-sql/postgres";
import { BOMB_RADIUS } from "pixel-war-sdk";
import type { Hex } from "viem";

// Typewriter generates one Drizzle table per Solidity `Mutation` enum member and
// the app reads them to build views. The generated types are not exported as a
// static shape, so queries reach in dynamically.
// biome-ignore lint/suspicious/noExplicitAny: generated per-mutation schema is accessed by name
type PixelWarSchema = any;
type QueryDatabase = BunSQLDatabase & { readonly $client: Bun.SQL };

/// Every mutation table, in enum order.
const mutationTableNames = [
  "initialize_mutations",
  "authorize_mutations",
  "revoke_mutations",
  "advanceepoch_mutations",
  "shield_mutations",
  "paint_mutations",
  "bomb_mutations",
] as const;

/// The tables that carry a canvas coordinate.
const actionTableNames = [
  "shield_mutations",
  "paint_mutations",
  "bomb_mutations",
] as const;

const MUTATION_NAME_BY_TABLE: Record<string, string> = {
  initialize_mutations: "Initialize",
  authorize_mutations: "Authorize",
  revoke_mutations: "Revoke",
  advanceepoch_mutations: "AdvanceEpoch",
  shield_mutations: "Shield",
  paint_mutations: "Paint",
  bomb_mutations: "Bomb",
};

export type ActionRow = {
  id: number;
  name: string;
  status: string;
  account: Hex;
  x: number;
  y: number;
  color: number | null;
  blockNumber: string | null;
  transactionHash: string | null;
  acceptedAt: string | null;
};

function toActionRow(
  table: string,
  // biome-ignore lint/suspicious/noExplicitAny: row shape comes from the generated schema
  row: any,
): ActionRow {
  return {
    id: row.id,
    name: MUTATION_NAME_BY_TABLE[table] ?? table,
    status: row.status,
    account: row.signature_account,
    x: Number(row.x),
    y: Number(row.y),
    color:
      row.color === undefined || row.color === null ? null : Number(row.color),
    blockNumber: row.blockNumber === null ? null : String(row.blockNumber),
    transactionHash: row.transactionHash ?? null,
    acceptedAt: row.acceptedAt === null ? null : String(row.acceptedAt),
  };
}

/// Accepted mutations in the last `windowMs`, used for the throughput readout.
export async function selectRecentMutationCount(
  db: QueryDatabase,
  schema: PixelWarSchema,
  windowMs: number,
): Promise<number> {
  const since = new Date(Date.now() - windowMs);
  const counts = await Promise.all(
    mutationTableNames.map(async (name) => {
      const table = schema[name];
      const [row] = await db
        .select({ value: count() })
        .from(table)
        .where(gte(table.acceptedAt, since));
      return Number(row?.value ?? 0);
    }),
  );
  return counts.reduce((total, value) => total + value, 0);
}

/// Who last hit a pixel. Paints match the exact coordinate; bombs match anything
/// whose blast square covers it, using the contract's radius.
export async function selectPixelHistory(
  db: QueryDatabase,
  schema: PixelWarSchema,
  x: number,
  y: number,
  limit: number,
): Promise<ActionRow[]> {
  const rows = await Promise.all(
    actionTableNames.map(async (name) => {
      const table = schema[name];
      const radius = name === "bomb_mutations" ? BOMB_RADIUS : 0;
      const found = await db
        .select()
        .from(table)
        .where(
          and(
            gte(table.x, x - radius),
            lte(table.x, x + radius),
            gte(table.y, y - radius),
            lte(table.y, y + radius),
          ),
        )
        .orderBy(desc(table.id))
        .limit(limit);
      return found.map((row) => toActionRow(name, row));
    }),
  );
  return rows
    .flat()
    .sort((a, b) => b.id - a.id)
    .slice(0, limit);
}

/// Most recent canvas actions across the three action tables.
export async function selectRecentActions(
  db: QueryDatabase,
  schema: PixelWarSchema,
  limit: number,
): Promise<ActionRow[]> {
  const rows = await Promise.all(
    actionTableNames.map(async (name) => {
      const table = schema[name];
      const found = await db
        .select()
        .from(table)
        .orderBy(desc(table.id))
        .limit(limit);
      return found.map((row) => toActionRow(name, row));
    }),
  );
  return rows
    .flat()
    .sort((a, b) => b.id - a.id)
    .slice(0, limit);
}

export type LeaderboardRow = {
  account: Hex;
  paints: number;
  shields: number;
  bombs: number;
  total: number;
};

/// Per-account action counts straight out of the generated mutation tables — no
/// separate indexer and no extra bookkeeping in the contract.
export async function selectLeaderboard(
  db: QueryDatabase,
  schema: PixelWarSchema,
  limit: number,
): Promise<LeaderboardRow[]> {
  const totals = new Map<Hex, LeaderboardRow>();

  for (const name of actionTableNames) {
    const table = schema[name];
    const rows = await db
      .select({ account: table.signature_account, value: count() })
      .from(table)
      .groupBy(table.signature_account);

    for (const row of rows) {
      const account = row.account as Hex;
      const entry = totals.get(account) ?? {
        account,
        paints: 0,
        shields: 0,
        bombs: 0,
        total: 0,
      };
      const value = Number(row.value ?? 0);
      if (name === "paint_mutations") entry.paints += value;
      if (name === "shield_mutations") entry.shields += value;
      if (name === "bomb_mutations") entry.bombs += value;
      entry.total += value;
      totals.set(account, entry);
    }
  }

  return [...totals.values()]
    .sort((a, b) => b.total - a.total || a.account.localeCompare(b.account))
    .slice(0, limit);
}

/// Mutation ids are unique across tables, so a lookup fans out and takes the one
/// hit.
export async function selectMutationById(
  db: QueryDatabase,
  schema: PixelWarSchema,
  id: number,
): Promise<Record<string, unknown> | null> {
  for (const name of mutationTableNames) {
    const table = schema[name];
    const [row] = await db
      .select()
      .from(table)
      .where(eq(table.id, id))
      .limit(1);
    if (row !== undefined) {
      return { ...row, name: MUTATION_NAME_BY_TABLE[name] ?? name };
    }
  }
  return null;
}

export async function selectMutationsByAccount(
  db: QueryDatabase,
  schema: PixelWarSchema,
  account: Hex,
  limit: number,
): Promise<Record<string, unknown>[]> {
  const rows = await Promise.all(
    mutationTableNames.map(async (name) => {
      const table = schema[name];
      const found = await db
        .select()
        .from(table)
        .where(eq(table.signature_account, account))
        .orderBy(desc(table.id))
        .limit(limit);
      return found.map(
        (row): Record<string, unknown> => ({
          ...row,
          name: MUTATION_NAME_BY_TABLE[name] ?? name,
        }),
      );
    }),
  );
  return rows
    .flat()
    .sort((a, b) => Number(b.id) - Number(a.id))
    .slice(0, limit);
}
