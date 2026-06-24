import type { AbiParameter } from "abitype";
import {
  and,
  asc,
  desc,
  eq,
  getColumns,
  inArray,
  lt,
  notInArray,
  sql,
} from "drizzle-orm";
import type { PgColumn, PgTable } from "drizzle-orm/pg-core";
import { Effect } from "effect";
import type { Hex } from "ox";
import type { AccountStorage } from "storage-layout";
import type { ExecuteResult } from "typewriter-evm";
import type { TypewriterDatabaseTransaction } from "./config";
import { Database, type DatabaseClient } from "./db";
import type {
  ExecutableMutation,
  RuntimeBlock,
  RuntimeMutation,
  SubmittedMutation,
} from "./types";

/** Postgres protocol limit: 32767 bind parameters per query. */
const MAX_PG_PARAMS = 32_767;
const SETTLED_MUTATION_STATUSES = ["included", "safe", "finalized"];

function chunk<T>(array: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < array.length; i += size) {
    chunks.push(array.slice(i, i + size));
  }
  return chunks;
}

export function insertMutation(
  tx: TypewriterDatabaseTransaction,
  schema: Record<string, PgTable>,
  mutation: ExecutableMutation,
): Effect.Effect<void, unknown> {
  return Effect.gen(function* () {
    const table = getMutationTable(schema, mutation.name);
    yield* tx.insert(table).values(mutationRow(mutation));
  });
}

// Batched counterpart to `insertMutation`. Mutations are grouped by their
// generated table (one per mutation name) so each table receives a single
// multi-row insert instead of one statement per mutation.
export function insertMutations(
  tx: TypewriterDatabaseTransaction,
  schema: Record<string, PgTable>,
  mutations: readonly ExecutableMutation[],
): Effect.Effect<void, unknown> {
  return Effect.gen(function* () {
    if (mutations.length === 0) return;

    const rowsByTable = new Map<
      string,
      { table: PgTable; rows: Record<string, unknown>[] }
    >();
    for (const mutation of mutations) {
      const tableName = `${mutation.name.toLowerCase()}_mutations`;
      let group = rowsByTable.get(tableName);
      if (group === undefined) {
        group = { table: getMutationTable(schema, mutation.name), rows: [] };
        rowsByTable.set(tableName, group);
      }
      group.rows.push(mutationRow(mutation));
    }

    for (const { table, rows } of rowsByTable.values()) {
      const columnCount = Object.keys(rows[0]!).length;
      const chunkSize = Math.floor(MAX_PG_PARAMS / Math.max(1, columnCount));
      for (const batch of chunk(rows, chunkSize)) {
        yield* tx.insert(table).values(batch);
      }
    }
  });
}

function mutationRow(mutation: ExecutableMutation): Record<string, unknown> {
  return {
    id: mutation.id,
    executionIndex: (mutation as { executionIndex: bigint }).executionIndex,
    status: "accepted",
    ...abiParameterValues(mutation.config.params, mutation.params),
    ...prefixedObjectValues("signature_", mutation.signature),
  };
}

export function selectNextMutationId(
  schema: Record<string, PgTable>,
): Effect.Effect<number, unknown, Database> {
  return Effect.gen(function* () {
    const db = yield* Database;
    let maxMutationId = -1;

    for (const [tableName, table] of Object.entries(schema)) {
      if (!tableName.endsWith("_mutations")) continue;

      // biome-ignore lint/suspicious/noExplicitAny: mutation tables share typewriter's id column by convention
      const mutationTable = getColumns(table) as any;
      const [row] = yield* db
        .select({
          maxMutationId: sql<number>`coalesce(max(${mutationTable.id}), -1)`,
        })
        .from(table);
      if (row !== undefined && row.maxMutationId > maxMutationId) {
        maxMutationId = row.maxMutationId;
      }
    }

    return maxMutationId + 1;
  });
}

export function updateMutationLifecycle(
  tx: TypewriterDatabaseTransaction,
  schema: Record<string, PgTable>,
  mutation: SubmittedMutation,
  block: RuntimeBlock<"fifo" | "batch">,
): Effect.Effect<void, unknown> {
  return Effect.gen(function* () {
    const table = getMutationTable(schema, mutation.name);
    const columns = getColumns(table);
    const idColumn = (columns as Record<"id", PgColumn>).id;

    yield* tx
      .update(table)
      .set(lifecycleSet(mutation.status, block))
      .where(eq(idColumn, mutation.id));
  });
}

// Batched counterpart to `updateMutationLifecycle`. Mutations are grouped by
// (table, status) — the lifecycle `set` only depends on the target status and
// the shared block — so each group becomes a single `UPDATE ... WHERE id IN
// (...)` instead of one statement per mutation.
export function updateMutationsLifecycle(
  tx: TypewriterDatabaseTransaction,
  schema: Record<string, PgTable>,
  mutations: readonly SubmittedMutation[],
  block: RuntimeBlock<"fifo" | "batch">,
): Effect.Effect<void, unknown> {
  return Effect.gen(function* () {
    if (mutations.length === 0) return;

    const groups = new Map<
      string,
      { table: PgTable; status: SubmittedMutation["status"]; ids: number[] }
    >();
    for (const mutation of mutations) {
      const key = `${mutation.name.toLowerCase()}_mutations|${mutation.status}`;
      let group = groups.get(key);
      if (group === undefined) {
        group = {
          table: getMutationTable(schema, mutation.name),
          status: mutation.status,
          ids: [],
        };
        groups.set(key, group);
      }
      group.ids.push(mutation.id);
    }

    for (const { table, status, ids } of groups.values()) {
      const columns = getColumns(table);
      const idColumn = (columns as Record<"id", PgColumn>).id;
      for (const batch of chunk(ids, 30_000)) {
        yield* tx
          .update(table)
          .set(lifecycleSet(status, block))
          .where(inArray(idColumn, batch));
      }
    }
  });
}

export function recoverIncludedMutationsBeforeExecutionIndex(
  tx: DatabaseClient,
  table: PgTable,
  executionIndex: bigint,
): Effect.Effect<void, unknown> {
  return Effect.gen(function* () {
    const columns = getColumns(table) as unknown as Record<
      "status" | "executionIndex",
      PgColumn
    >;
    const { status: statusColumn, executionIndex: executionIndexColumn } =
      columns;

    yield* tx
      .update(table)
      .set({ status: "included", includedAt: sql`NOW()` })
      .where(
        and(
          eq(statusColumn, "accepted"),
          lt(executionIndexColumn, executionIndex),
        ),
      );
  });
}

export function deleteSlotWritesForUnsettledMutations(
  tx: DatabaseClient,
  schema: Record<string, PgTable>,
  mutationTable: PgTable,
): Effect.Effect<void, unknown> {
  return Effect.gen(function* () {
    const { slot_writes: slotWritesTable } = schema as Record<
      "slot_writes",
      PgTable
    >;

    const slotWritesColumns = getColumns(slotWritesTable) as unknown as Record<
      "mutationId",
      PgColumn
    >;
    const mutationIdColumn = slotWritesColumns.mutationId;

    const mutationColumns = getColumns(mutationTable) as unknown as Record<
      "id" | "status",
      PgColumn
    >;
    const { id: idColumn, status: statusColumn } = mutationColumns;

    yield* tx
      .delete(slotWritesTable)
      .where(
        inArray(
          mutationIdColumn,
          tx
            .select({ id: idColumn })
            .from(mutationTable)
            .where(notInArray(statusColumn, SETTLED_MUTATION_STATUSES)),
        ),
      );
  });
}

export function deleteUnsettledMutationRows(
  tx: DatabaseClient,
  table: PgTable,
): Effect.Effect<void, unknown> {
  return Effect.gen(function* () {
    const columns = getColumns(table) as unknown as Record<"status", PgColumn>;
    const { status: statusColumn } = columns;

    yield* tx
      .delete(table)
      .where(notInArray(statusColumn, SETTLED_MUTATION_STATUSES));
  });
}

function lifecycleSet(
  status: SubmittedMutation["status"],
  block: RuntimeBlock<"fifo" | "batch">,
): Record<string, unknown> {
  return status === "included"
    ? {
        status,
        blockNumber: block?.number.toString(),
        blockHash: block?.hash,
        blockTimestamp: block?.timestamp.toString(),
        transactionHash: block?.transactionHash,
        includedAt: sql`NOW()`,
      }
    : status === "safe"
      ? { status, safeAt: sql`NOW()` }
      : { status, finalizedAt: sql`NOW()` };
}

export function insertSlotWrites(
  tx: TypewriterDatabaseTransaction,
  schema: Record<string, PgTable>,
  mutation: Pick<RuntimeMutation, "id">,
  slotWrites: ExecuteResult["slot_writes"],
): Effect.Effect<void, unknown> {
  return Effect.gen(function* () {
    if (slotWrites.length === 0) return;

    yield* tx.insert(getTable(schema, "slot_writes")).values(
      slotWrites.map((write) => ({
        mutationId: mutation.id,
        slot: write.slot,
        value: write.new_value,
      })),
    );
  });
}

// Batched counterpart to `insertSlotWrites`. Slot writes from every mutation
// are flattened into a single insert. The flatten preserves the order of
// `entries` (and of each mutation's writes), which keeps the table's `serial`
// id monotonic in application order so `selectAccountStorage` still resolves
// the latest value per slot correctly.
export function insertSlotWritesMany(
  tx: TypewriterDatabaseTransaction,
  schema: Record<string, PgTable>,
  mutationsWithResults: readonly {
    mutation: Pick<RuntimeMutation, "id">;
    executeResult: Pick<ExecuteResult, "slot_writes">;
  }[],
): Effect.Effect<void, unknown> {
  return Effect.gen(function* () {
    const rows = mutationsWithResults.flatMap(({ mutation, executeResult }) =>
      executeResult.slot_writes.map((write) => ({
        mutationId: mutation.id,
        slot: write.slot,
        value: write.new_value,
      })),
    );
    if (rows.length === 0) return;

    // slot_writes rows have 3 columns (mutationId, slot, value)
    for (const batch of chunk(rows, 10_000)) {
      yield* tx.insert(getTable(schema, "slot_writes")).values(batch);
    }
  });
}

export function insertKnownPaths(
  tx: TypewriterDatabaseTransaction,
  schema: Record<string, PgTable>,
  paths: readonly string[],
): Effect.Effect<void, unknown> {
  return Effect.gen(function* () {
    if (paths.length === 0) return;

    const rows = paths.map((path) => ({ path }));
    for (const batch of chunk(rows, 30_000)) {
      yield* tx
        .insert(getTable(schema, "known_paths"))
        .values(batch)
        .onConflictDoNothing();
    }
  });
}

export function selectKnownPaths(
  tx: TypewriterDatabaseTransaction,
  schema: Record<string, PgTable>,
): Effect.Effect<string[], unknown> {
  return Effect.gen(function* () {
    const table = getTable(schema, "known_paths");
    const columns = getColumns(table);
    const pathColumn = (columns as Record<"path", PgColumn>).path;

    const rows = yield* tx
      .select({ path: pathColumn })
      .from(table)
      .orderBy(asc(pathColumn));
    return rows.map((row) => String(row.path));
  });
}

export function selectAccountStorage(
  tx: TypewriterDatabaseTransaction,
  schema: Record<string, PgTable>,
): Effect.Effect<AccountStorage, unknown> {
  return Effect.gen(function* () {
    const table = getTable(schema, "slot_writes");
    const columns = getColumns(table);
    const dynamicColumns = columns as Record<"id" | "slot" | "value", PgColumn>;
    const idColumn = dynamicColumns.id;
    const slotColumn = dynamicColumns.slot;
    const valueColumn = dynamicColumns.value;

    const rows = yield* tx
      .selectDistinctOn([slotColumn], {
        slot: slotColumn,
        value: valueColumn,
      })
      .from(table)
      .orderBy(asc(slotColumn), desc(idColumn));

    const storage: AccountStorage = {};
    for (const row of rows) {
      storage[row.slot as Hex.Hex] = row.value as Hex.Hex;
    }
    return storage;
  });
}

function getMutationTable(
  schema: Record<string, PgTable>,
  mutationName: string,
): PgTable {
  return getTable(schema, `${mutationName.toLowerCase()}_mutations`);
}

function getTable(schema: Record<string, PgTable>, tableName: string): PgTable {
  return schema[tableName]!;
}

function abiParameterValues(
  params: readonly AbiParameter[],
  values: unknown,
  prefix = "",
): Record<string, unknown> {
  const row: Record<string, unknown> = {};
  for (let index = 0; index < params.length; index++) {
    const param = params[index];
    if (param === undefined) continue;
    const name =
      param.name === undefined || param.name === ""
        ? `arg${index}`
        : param.name;
    const value = Array.isArray(values)
      ? values[index]
      : recordValue(values, name);
    row[`${prefix}${name}`] = serializeAbiValue(param.type, value);
  }
  return row;
}

function prefixedObjectValues(
  prefix: string,
  value: unknown,
): Record<string, unknown> {
  if (!isRecord(value)) {
    return { [`${prefix}signature`]: serializeJsonValue(value) };
  }

  const row: Record<string, unknown> = {};
  for (const [name, entry] of Object.entries(value)) {
    row[`${prefix}${name}`] = serializeJsonValue(entry);
  }
  return row;
}

function recordValue(value: unknown, key: string): unknown {
  return (value as Record<string, unknown>)[key];
}

function serializeAbiValue(type: string, value: unknown): unknown {
  if (type.includes("[") || type.startsWith("tuple")) {
    return serializeJsonValue(value);
  }
  if (type === "uint" || type === "int") return integerValue(value, "numeric");

  const uint = /^uint([0-9]+)$/.exec(type);
  if (uint !== null)
    return integerValue(value, unsignedIntegerMode(Number(uint[1])));

  const int = /^int([0-9]+)$/.exec(type);
  if (int !== null)
    return integerValue(value, signedIntegerMode(Number(int[1])));

  if (/^u?fixed([0-9]+)x([0-9]+)$/.test(type)) {
    return integerValue(value, "numeric");
  }

  return serializeJsonValue(value);
}

function unsignedIntegerMode(bits: number): "number" | "bigint" | "numeric" {
  if (bits <= 24) return "number";
  if (bits <= 56) return "bigint";
  return "numeric";
}

function signedIntegerMode(bits: number): "number" | "bigint" | "numeric" {
  if (bits <= 32) return "number";
  if (bits <= 64) return "bigint";
  return "numeric";
}

function integerValue(
  value: unknown,
  mode: "number" | "bigint" | "numeric",
): number | bigint | string {
  if (mode === "number") return Number(value);
  if (mode === "bigint") return BigInt(value as string | number | bigint);
  return value?.toString() ?? "";
}

function serializeJsonValue(value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map(serializeJsonValue);
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        serializeJsonValue(entry),
      ]),
    );
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
