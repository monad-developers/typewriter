// Read-side query helpers for the order-book HTTP API.
//
// FFCA persists one generated table per mutation type. To answer API queries
// that span mutation types, fan out across those tables and merge app-side.

import { and, desc, eq } from "drizzle-orm";
import type { BunSQLDatabase } from "drizzle-orm/bun-sql/postgres";
import type { PgTable } from "drizzle-orm/pg-core";
import type { Hex } from "viem";
import * as schema from "./app-schema";

export type QueryDatabase = BunSQLDatabase & { readonly $client: Bun.SQL };

export type ApiMutationStatus = "accepted" | "included" | "safe" | "finalized";

export type ApiMutation = {
  id: number;
  bundleId: number | null;
  bundlePosition: number | null;
  blockNumber: string | null;
  status: ApiMutationStatus;
  account: Hex;
  accountSerial: number | null;
  keyIndex: string | null;
  nonce: string | null;
  deadline: string | null;
  type: string;
  // Submitted mutations are not persisted in this model; `submittedAt` is
  // always null in REST responses. Kept on the wire for SSE/REST shape parity.
  submittedAt: string | null;
  acceptedAt: string | null;
  includedAt: string | null;
  safeAt: string | null;
  finalizedAt: string | null;
  transactionHash: Hex | null;
  payload: unknown;
};

export type BlockInfo = {
  number: string;
  hash: string;
  timestamp: string;
};

// Columns shared across every per-mutation table via `mutationColumns()` +
// `signatureColumns`. Stripped from each row before being returned as the
// `payload` field so consumers see only per-type fields.
const SHARED_COLUMNS = new Set<string>([
  "id",
  "bundleId",
  "bundlePosition",
  "blockNumber",
  "blockHash",
  "blockTimestamp",
  "transactionHash",
  "status",
  "acceptedAt",
  "includedAt",
  "safeAt",
  "finalizedAt",
  "signatureAccount",
  "signatureKeyId",
  "signatureRawSignature",
]);

type MutationRow = {
  id: number;
  bundleId: number | null;
  bundlePosition: number | null;
  blockNumber: string | null;
  blockHash: string | null;
  blockTimestamp: string | null;
  transactionHash: string | null;
  status: ApiMutationStatus;
  acceptedAt: Date | null;
  includedAt: Date | null;
  safeAt: Date | null;
  finalizedAt: Date | null;
  signatureAccount: string;
  signatureKeyId: string;
  signatureRawSignature: string;
  // Payload-specific columns vary by table; widened to any here. Each
  // descriptor's `projectPayload` handles the per-type field projection.
  // biome-ignore lint/suspicious/noExplicitAny: per-type payload columns differ
  [key: string]: any;
};

type TableDescriptor = {
  type: string;
  // biome-ignore lint/suspicious/noExplicitAny: descriptors must hold any per-type pgTable
  table: any;
  hasNonce: boolean;
  // Returns the per-type payload object. Strips shared mutation columns and
  // stringifies bigints to keep the JSON response stable across mutation
  // types.
  // biome-ignore lint/suspicious/noExplicitAny: per-type row shapes differ
  projectPayload: (row: MutationRow) => any;
};

// biome-ignore lint/suspicious/noExplicitAny: same reason as above
function stripShared(row: MutationRow): Record<string, any> {
  // biome-ignore lint/suspicious/noExplicitAny: see TableDescriptor
  const payload: Record<string, any> = {};
  for (const [key, value] of Object.entries(row)) {
    if (SHARED_COLUMNS.has(key)) continue;
    payload[key] = typeof value === "bigint" ? value.toString() : value;
  }
  return payload;
}

// Descriptors are keyed by the same camelCase strings used by SSE
// (`mutationType()` in src/index.ts). Adding a new mutation type means
// registering it here too, alongside the per-type table.
const TABLES: TableDescriptor[] = [
  {
    type: "initialize",
    table: schema.initializes,
    hasNonce: false,
    projectPayload: stripShared,
  },
  {
    type: "authorize",
    table: schema.authorizes,
    hasNonce: true,
    projectPayload: stripShared,
  },
  {
    type: "revoke",
    table: schema.revokes,
    hasNonce: true,
    projectPayload: stripShared,
  },
  {
    type: "closeOrder",
    table: schema.closeOrders,
    hasNonce: true,
    projectPayload: stripShared,
  },
  {
    type: "changeOrder",
    table: schema.changeOrders,
    hasNonce: true,
    projectPayload: stripShared,
  },
  {
    type: "limitOrder",
    table: schema.limitOrders,
    hasNonce: true,
    projectPayload: stripShared,
  },
  {
    type: "marketOrder",
    table: schema.marketOrders,
    hasNonce: true,
    projectPayload: stripShared,
  },
  {
    type: "addInstrument",
    table: schema.addInstruments,
    hasNonce: true,
    projectPayload: stripShared,
  },
  {
    type: "deposit",
    table: schema.deposits,
    hasNonce: true,
    projectPayload: stripShared,
  },
  {
    type: "withdrawal",
    table: schema.withdrawals,
    hasNonce: true,
    projectPayload: stripShared,
  },
];

type Typed<T> = { descriptor: TableDescriptor; row: T };

function toIso(value: Date | string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  return value instanceof Date ? value.toISOString() : value;
}

function buildApiMutation(
  descriptor: TableDescriptor,
  row: MutationRow,
  payload: unknown,
): ApiMutation {
  return {
    id: row.id,
    bundleId: row.bundleId,
    bundlePosition: row.bundlePosition,
    blockNumber: row.blockNumber,
    status: row.status,
    account: row.signatureAccount as Hex,
    accountSerial: null,
    keyIndex:
      row.signatureKeyId !== null ? row.signatureKeyId.toString() : null,
    nonce:
      descriptor.hasNonce && row.nonce !== undefined && row.nonce !== null
        ? typeof row.nonce === "bigint"
          ? row.nonce.toString()
          : String(row.nonce)
        : null,
    deadline:
      row.deadline !== undefined && row.deadline !== null
        ? typeof row.deadline === "bigint"
          ? row.deadline.toString()
          : String(row.deadline)
        : null,
    type: descriptor.type,
    submittedAt: null,
    acceptedAt: toIso(row.acceptedAt),
    includedAt: toIso(row.includedAt),
    safeAt: toIso(row.safeAt),
    finalizedAt: toIso(row.finalizedAt),
    transactionHash: (row.transactionHash ?? null) as Hex | null,
    payload,
  };
}

async function assembleMutations(
  _db: QueryDatabase,
  typed: Typed<MutationRow>[],
): Promise<ApiMutation[]> {
  if (typed.length === 0) return [];

  return typed.map((t) => {
    const basePayload = t.descriptor.projectPayload(t.row);
    const payload =
      t.descriptor.type === "marketOrder"
        ? { ...basePayload, fills: t.row.resolutionFills ?? [] }
        : basePayload;
    return buildApiMutation(t.descriptor, t.row, payload);
  });
}

function sortByBundleOrder(a: ApiMutation, b: ApiMutation): number {
  const aBundle = a.bundleId ?? Number.POSITIVE_INFINITY;
  const bBundle = b.bundleId ?? Number.POSITIVE_INFINITY;
  if (aBundle !== bBundle) return aBundle - bBundle;
  const aPos = a.bundlePosition ?? Number.POSITIVE_INFINITY;
  const bPos = b.bundlePosition ?? Number.POSITIVE_INFINITY;
  if (aPos !== bPos) return aPos - bPos;
  return a.id - b.id;
}

// Returns block metadata for the first mutation found at `blockNumber` across
// any per-type table. Returns null if no persisted mutation references the
// block. Bundles that landed in a block without persisted mutations are not
// representable without a central blocks table, but the runtime never emits
// such blocks today.
export async function loadBlock(
  db: QueryDatabase,
  blockNumber: string,
): Promise<BlockInfo | null> {
  const results = await Promise.all(
    TABLES.map((descriptor) =>
      db
        .select({
          blockNumber: descriptor.table.blockNumber,
          blockHash: descriptor.table.blockHash,
          blockTimestamp: descriptor.table.blockTimestamp,
        })
        .from(descriptor.table as PgTable)
        .where(eq(descriptor.table.blockNumber, blockNumber))
        .limit(1),
    ),
  );
  for (const rows of results) {
    const row = rows[0];
    if (
      row !== undefined &&
      row.blockNumber !== null &&
      row.blockHash !== null &&
      row.blockTimestamp !== null
    ) {
      return {
        number: row.blockNumber,
        hash: row.blockHash,
        timestamp: row.blockTimestamp,
      };
    }
  }
  return null;
}

export async function loadMutationsByBlock(
  db: QueryDatabase,
  blockNumber: string,
): Promise<ApiMutation[]> {
  const perTable = await Promise.all(
    TABLES.map(async (descriptor) => {
      const rows = (await db
        .select()
        .from(descriptor.table as PgTable)
        .where(eq(descriptor.table.blockNumber, blockNumber))) as MutationRow[];
      return rows.map((row) => ({ descriptor, row }));
    }),
  );
  const typed = perTable.flat();
  const mutations = await assembleMutations(db, typed);
  return mutations.sort(sortByBundleOrder);
}

export async function loadMutationById(
  db: QueryDatabase,
  id: number,
): Promise<ApiMutation | null> {
  const perTable = await Promise.all(
    TABLES.map(async (descriptor) => {
      const rows = (await db
        .select()
        .from(descriptor.table as PgTable)
        .where(eq(descriptor.table.id, id))
        .limit(1)) as MutationRow[];
      return rows.map((row) => ({ descriptor, row }));
    }),
  );
  const typed = perTable.flat();
  if (typed.length === 0) return null;
  const [first] = await assembleMutations(db, typed.slice(0, 1));
  return first ?? null;
}

export async function loadMutationByAccountNonce(
  db: QueryDatabase,
  account: Hex,
  nonce: string,
): Promise<ApiMutation | null> {
  const candidates = TABLES.filter((descriptor) => descriptor.hasNonce);
  const perTable = await Promise.all(
    candidates.map(async (descriptor) => {
      const rows = (await db
        .select()
        .from(descriptor.table as PgTable)
        .where(
          and(
            eq(descriptor.table.signatureAccount, account),
            eq(descriptor.table.nonce, nonce),
          ),
        )
        .limit(1)) as MutationRow[];
      return rows.map((row) => ({ descriptor, row }));
    }),
  );
  const typed = perTable.flat();
  if (typed.length === 0) return null;
  const [first] = await assembleMutations(db, typed.slice(0, 1));
  return first ?? null;
}

export async function loadMutationsByAccount(
  db: QueryDatabase,
  account: Hex,
  limit: number,
): Promise<ApiMutation[]> {
  const perTable = await Promise.all(
    TABLES.map(async (descriptor) => {
      const rows = (await db
        .select()
        .from(descriptor.table as PgTable)
        .where(eq(descriptor.table.signatureAccount, account))
        .orderBy(desc(descriptor.table.id))
        .limit(limit)) as MutationRow[];
      return rows.map((row) => ({ descriptor, row }));
    }),
  );
  const typed = perTable.flat();
  // Apply the global limit after the per-table top-N has been gathered.
  typed.sort((a, b) => b.row.id - a.row.id);
  const top = typed.slice(0, limit);
  return assembleMutations(db, top);
}
