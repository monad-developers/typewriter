import type { AbiParameter } from "abitype";
import { asc, desc, eq, getColumns, sql } from "drizzle-orm";
import type { PgColumn, PgTable } from "drizzle-orm/pg-core";
import { Effect } from "effect";
import type { ExecuteResult } from "ffca-evm";
import type { Hex } from "ox";
import type { AccountStorage } from "storage-layout";
import type { FFCADatabaseTransaction } from "./config";
import { Database } from "./db";
import type {
  MutationWithResolution,
  RuntimeBlock,
  RuntimeMutation,
  SubmittedMutation,
} from "./types";

export function insertMutation(
  tx: FFCADatabaseTransaction,
  schema: Record<string, PgTable>,
  mutation: MutationWithResolution,
): Effect.Effect<void, unknown> {
  return Effect.gen(function* () {
    const table = getMutationTable(schema, mutation.name);
    const row = {
      id: mutation.id,
      status: "accepted",
      ...abiParameterValues(mutation.config.params, mutation.args),
      ...prefixedObjectValues("signature_", mutation.signature),
      ...("resolution" in mutation.config
        ? abiParameterValues(
            mutation.config.resolution,
            requiredValue(mutation.resolution),
            "resolution_",
          )
        : {}),
    };

    yield* tx.insert(table).values(row);
  });
}

export function selectNextMutationId(
  schema: Record<string, PgTable>,
): Effect.Effect<number, unknown, Database> {
  return Effect.gen(function* () {
    const db = yield* Database;
    let maxMutationId = -1;

    for (const [tableName, table] of Object.entries(schema)) {
      if (!tableName.endsWith("_mutations")) continue;

      // biome-ignore lint/suspicious/noExplicitAny: mutation tables share ffca's id column by convention
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
  tx: FFCADatabaseTransaction,
  schema: Record<string, PgTable>,
  mutation: SubmittedMutation,
  block: RuntimeBlock<"fifo" | "batch">,
): Effect.Effect<void, unknown> {
  return Effect.gen(function* () {
    const table = getMutationTable(schema, mutation.name);
    const columns = getColumns(table);
    const idColumn = (columns as Record<"id", PgColumn>).id;

    const set: Record<string, unknown> =
      mutation.status === "included"
        ? {
            status: mutation.status,
            blockNumber: block?.number.toString(),
            blockHash: block?.hash,
            blockTimestamp: block?.timestamp.toString(),
            transactionHash: block?.transactionHash,
            includedAt: sql`NOW()`,
          }
        : mutation.status === "safe"
          ? { status: mutation.status, safeAt: sql`NOW()` }
          : { status: mutation.status, finalizedAt: sql`NOW()` };

    yield* tx.update(table).set(set).where(eq(idColumn, mutation.id));
  });
}

export function insertSlotWrites(
  tx: FFCADatabaseTransaction,
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

export function insertKnownPaths(
  tx: FFCADatabaseTransaction,
  schema: Record<string, PgTable>,
  paths: readonly string[],
): Effect.Effect<void, unknown> {
  return Effect.gen(function* () {
    if (paths.length === 0) return;

    yield* tx
      .insert(getTable(schema, "known_paths"))
      .values(paths.map((path) => ({ path })))
      .onConflictDoNothing();
  });
}

export function selectKnownPaths(
  tx: FFCADatabaseTransaction,
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
  tx: FFCADatabaseTransaction,
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
  const row: Record<string, unknown> = {};
  for (const [name, entry] of Object.entries(
    value as Record<string, unknown>,
  )) {
    row[`${prefix}${name}`] = serializeJsonValue(entry);
  }
  return row;
}

function recordValue(value: unknown, key: string): unknown {
  return (value as Record<string, unknown>)[key];
}

function requiredValue<T>(value: T | undefined): T {
  return value as T;
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
