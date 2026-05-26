// Read-side query helpers for the order-book HTTP API.
//
// FFCA persists one generated table per mutation type. To answer API queries
// that span mutation types, fan out across those tables and merge app-side.

import { and, desc, eq } from "drizzle-orm";
import type { BunSQLDatabase } from "drizzle-orm/bun-sql/postgres";
import type { PgTable } from "drizzle-orm/pg-core";
import type { FFCASchema } from "ffca";
import type { Hex } from "viem";
import type { OrderBookFFCAConfig } from "./app";

export type OrderBookSchema = FFCASchema<OrderBookFFCAConfig>;

export type QueryDatabase = BunSQLDatabase & { readonly $client: Bun.SQL };

export type ApiMutationStatus = "accepted" | "included" | "safe" | "finalized";

export type ApiMutation = {
  id: number;
  batchId: number | null;
  batchPosition: number | null;
  blockNumber: string | null;
  status: ApiMutationStatus;
  account: Hex;
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

// Columns shared across every per-mutation table via FFCA's mutationColumns()
// and signature column helpers. Stripped from each row before being returned
// as the `payload` field so consumers see only per-type fields.
const SHARED_COLUMNS = new Set<string>([
  "id",
  "blockNumber",
  "blockHash",
  "blockTimestamp",
  "transactionHash",
  "status",
  "acceptedAt",
  "includedAt",
  "safeAt",
  "finalizedAt",
  "signature_account",
  "signature_keyId",
  "signature_rawSignature",
]);

type MutationRow = {
  id: number;
  // FFCA's `mutationColumns` declares `blockNumber` / `blockTimestamp` as
  // `numeric(78,0)` in bigint mode, so the read-side gets a JS `bigint` (or
  // `null` when not yet included). `signature_keyId` is `uint64`, also bigint.
  blockNumber: bigint | null;
  blockHash: string | null;
  blockTimestamp: bigint | null;
  transactionHash: string | null;
  status: ApiMutationStatus;
  acceptedAt: Date | null;
  includedAt: Date | null;
  safeAt: Date | null;
  finalizedAt: Date | null;
  signature_account: string;
  signature_keyId: bigint;
  signature_rawSignature: string;
  // Payload-specific columns vary by table; widened to any here. Each
  // descriptor's `projectPayload` handles the per-type field projection.
  // biome-ignore lint/suspicious/noExplicitAny: per-type payload columns differ
  [key: string]: any;
};

type TableDescriptor = {
  // camelCase type name surfaced on the wire (matches SSE `mutationType()`).
  type: string;
  // FFCA's lowercased schema key: e.g. `initialize_mutations`.
  schemaKey: keyof OrderBookSchema;
  hasNonce: boolean;
};

// Maps wire `type` (camelCase) → FFCA-generated schema key (lowercased plural).
const TABLES: TableDescriptor[] = [
  { type: "initialize", schemaKey: "initialize_mutations", hasNonce: false },
  { type: "authorize", schemaKey: "authorize_mutations", hasNonce: true },
  { type: "revoke", schemaKey: "revoke_mutations", hasNonce: true },
  { type: "closeOrder", schemaKey: "closeorder_mutations", hasNonce: true },
  { type: "changeOrder", schemaKey: "changeorder_mutations", hasNonce: true },
  { type: "limitOrder", schemaKey: "limitorder_mutations", hasNonce: true },
  { type: "marketOrder", schemaKey: "marketorder_mutations", hasNonce: true },
  {
    type: "addInstrument",
    schemaKey: "addinstrument_mutations",
    hasNonce: true,
  },
  { type: "deposit", schemaKey: "deposit_mutations", hasNonce: true },
  { type: "withdrawal", schemaKey: "withdrawal_mutations", hasNonce: true },
];

type ResolvedDescriptor = TableDescriptor & {
  // biome-ignore lint/suspicious/noExplicitAny: per-type pgTable shapes differ
  table: any;
};

function resolveTables(schema: OrderBookSchema): ResolvedDescriptor[] {
  return TABLES.map((descriptor) => ({
    ...descriptor,
    table: schema[descriptor.schemaKey],
  }));
}

// biome-ignore lint/suspicious/noExplicitAny: per-type payload columns differ
function stripShared(row: MutationRow): Record<string, any> {
  // biome-ignore lint/suspicious/noExplicitAny: see MutationRow
  const payload: Record<string, any> = {};
  for (const [key, value] of Object.entries(row)) {
    if (SHARED_COLUMNS.has(key)) continue;
    payload[key] = typeof value === "bigint" ? value.toString() : value;
  }
  return payload;
}

type Typed<T> = { descriptor: ResolvedDescriptor; row: T };

function toIso(value: Date | string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  return value instanceof Date ? value.toISOString() : value;
}

function buildApiMutation(
  descriptor: ResolvedDescriptor,
  row: MutationRow,
  payload: unknown,
): ApiMutation {
  const keyId = row.signature_keyId;
  return {
    id: row.id,
    batchId: null,
    batchPosition: null,
    blockNumber: row.blockNumber === null ? null : row.blockNumber.toString(),
    status: row.status,
    account: row.signature_account as Hex,
    keyIndex: keyId === null || keyId === undefined ? null : keyId.toString(),
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

function assembleMutations(typed: Typed<MutationRow>[]): ApiMutation[] {
  if (typed.length === 0) return [];

  return typed.map((t) => {
    const basePayload = stripShared(t.row);
    const payload =
      t.descriptor.type === "marketOrder"
        ? { ...basePayload, fills: t.row.resolution_fills ?? [] }
        : basePayload;
    return buildApiMutation(t.descriptor, t.row, payload);
  });
}

function sortByMutationId(a: ApiMutation, b: ApiMutation): number {
  return a.id - b.id;
}

// Returns block metadata for the first mutation found at `blockNumber` across
// any per-type table. Returns null if no persisted mutation references the
// block. Batches that landed in a block without persisted mutations are not
// representable without a central blocks table, but the runtime never emits
// such blocks today.
export async function loadBlock(
  db: QueryDatabase,
  schema: OrderBookSchema,
  blockNumber: string,
): Promise<BlockInfo | null> {
  const tables = resolveTables(schema);
  const filter = BigInt(blockNumber);
  const results = await Promise.all(
    tables.map((descriptor) =>
      db
        .select({
          blockNumber: descriptor.table.blockNumber,
          blockHash: descriptor.table.blockHash,
          blockTimestamp: descriptor.table.blockTimestamp,
        })
        .from(descriptor.table as PgTable)
        .where(eq(descriptor.table.blockNumber, filter))
        .limit(1),
    ),
  );
  for (const rows of results) {
    const row = rows[0] as
      | { blockNumber: bigint; blockHash: string; blockTimestamp: bigint }
      | undefined;
    if (
      row !== undefined &&
      row.blockNumber !== null &&
      row.blockHash !== null &&
      row.blockTimestamp !== null
    ) {
      return {
        number: row.blockNumber.toString(),
        hash: row.blockHash,
        timestamp: row.blockTimestamp.toString(),
      };
    }
  }
  return null;
}

export async function loadMutationsByBlock(
  db: QueryDatabase,
  schema: OrderBookSchema,
  blockNumber: string,
): Promise<ApiMutation[]> {
  const tables = resolveTables(schema);
  const filter = BigInt(blockNumber);
  const perTable = await Promise.all(
    tables.map(async (descriptor) => {
      const rows = (await db
        .select()
        .from(descriptor.table as PgTable)
        .where(eq(descriptor.table.blockNumber, filter))) as MutationRow[];
      return rows.map((row) => ({ descriptor, row }));
    }),
  );
  return assembleMutations(perTable.flat()).sort(sortByMutationId);
}

export async function loadMutationById(
  db: QueryDatabase,
  schema: OrderBookSchema,
  id: number,
): Promise<ApiMutation | null> {
  const tables = resolveTables(schema);
  const perTable = await Promise.all(
    tables.map(async (descriptor) => {
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
  const [first] = assembleMutations(typed.slice(0, 1));
  return first ?? null;
}

export async function loadMutationByAccountNonce(
  db: QueryDatabase,
  schema: OrderBookSchema,
  account: Hex,
  nonce: string,
): Promise<ApiMutation | null> {
  const candidates = resolveTables(schema).filter(
    (descriptor) => descriptor.hasNonce,
  );
  // `nonce` is a `uint256` column in bigint mode; the filter literal needs to
  // be a `bigint` so drizzle serializes it the same way the column was stored.
  const filter = BigInt(nonce);
  const perTable = await Promise.all(
    candidates.map(async (descriptor) => {
      const rows = (await db
        .select()
        .from(descriptor.table as PgTable)
        .where(
          and(
            eq(descriptor.table.signature_account, account),
            eq(descriptor.table.nonce, filter),
          ),
        )
        .limit(1)) as MutationRow[];
      return rows.map((row) => ({ descriptor, row }));
    }),
  );
  const typed = perTable.flat();
  if (typed.length === 0) return null;
  const [first] = assembleMutations(typed.slice(0, 1));
  return first ?? null;
}

export async function loadMutationsByAccount(
  db: QueryDatabase,
  schema: OrderBookSchema,
  account: Hex,
  limit: number,
): Promise<ApiMutation[]> {
  const tables = resolveTables(schema);
  const perTable = await Promise.all(
    tables.map(async (descriptor) => {
      const rows = (await db
        .select()
        .from(descriptor.table as PgTable)
        .where(eq(descriptor.table.signature_account, account))
        .orderBy(desc(descriptor.table.id))
        .limit(limit)) as MutationRow[];
      return rows.map((row) => ({ descriptor, row }));
    }),
  );
  const typed = perTable.flat();
  // Apply the global limit after the per-table top-N has been gathered.
  typed.sort((a, b) => b.row.id - a.row.id);
  return assembleMutations(typed.slice(0, limit));
}

// Count mutations whose `acceptedAt` is within the last `windowMs` ms,
// across all per-type tables. Used for the TPS gauge.
export async function loadRecentMutationCount(
  db: QueryDatabase,
  schema: OrderBookSchema,
  windowMs: number,
): Promise<number> {
  const tables = resolveTables(schema);
  const cutoff = new Date(Date.now() - windowMs);
  const counts = await Promise.all(
    tables.map(async (descriptor) => {
      const rows = await db
        .select({ acceptedAt: descriptor.table.acceptedAt })
        .from(descriptor.table as PgTable);
      return rows.filter(
        (row) => row.acceptedAt !== null && row.acceptedAt >= cutoff,
      ).length;
    }),
  );
  return counts.reduce((total, count) => total + count, 0);
}
