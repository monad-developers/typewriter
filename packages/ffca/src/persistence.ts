import type { AbiParameter } from "abitype";
import type { AnyColumn } from "drizzle-orm";
import { eq, getTableColumns, sql } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";
import { Data, Effect } from "effect";
import type { FFCADatabaseTransaction } from "./config";
import type { ResolvedMutation, RuntimeBundle, RuntimeMutation } from "./types";

export class PersistenceError extends Data.TaggedError("PersistenceError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export function persistGeneratedMutation(
  tx: FFCADatabaseTransaction,
  schema: Record<string, PgTable>,
  mutation: ResolvedMutation,
  bundle: RuntimeBundle,
): Effect.Effect<void, unknown> {
  return Effect.gen(function* () {
    const table = generatedMutationTable(schema, mutation.name);
    const row = {
      id: mutation.id,
      bundleId: bundle.id,
      bundlePosition: bundle.position,
      status: "accepted",
      ...abiParameterValues(mutation.config.params, mutation.args),
      ...prefixedObjectValues("signature_", mutation.signature),
      ...("resolution" in mutation.config
        ? abiParameterValues(
            mutation.config.resolution,
            requiredValue(mutation.resolution, "resolution"),
            "resolution_",
          )
        : {}),
    };

    yield* tx.insert(table).values(row as never);
  });
}

export function persistUpdatedGeneratedMutationLifecycle(
  tx: FFCADatabaseTransaction,
  schema: Record<string, PgTable>,
  mutation: Extract<
    RuntimeMutation,
    { status: "accepted" | "included" | "safe" | "finalized" }
  >,
): Effect.Effect<void, unknown> {
  return Effect.gen(function* () {
    if (mutation.status === "accepted") {
      return yield* new PersistenceError({
        message: `generated mutation lifecycle update requires post-accepted status: ${mutation.name}`,
      });
    }

    const table = generatedMutationTable(schema, mutation.name);
    const columns = getTableColumns(table) as unknown as Record<
      string,
      AnyColumn
    > & { id?: AnyColumn };
    const idColumn = columns.id;
    if (idColumn === undefined) {
      return yield* new PersistenceError({
        message: `generated mutation table is missing id column: ${mutation.name}`,
      });
    }

    const set =
      mutation.status === "included"
        ? { status: mutation.status, includedAt: sql`NOW()` }
        : mutation.status === "safe"
          ? { status: mutation.status, safeAt: sql`NOW()` }
          : { status: mutation.status, finalizedAt: sql`NOW()` };

    yield* tx
      .update(table)
      .set(set as never)
      .where(eq(idColumn, mutation.id));
  });
}

function generatedMutationTable(
  schema: Record<string, PgTable>,
  mutationName: string,
): PgTable {
  const tableName = `${mutationName.toLowerCase()}_mutations`;
  const table = schema[tableName];
  if (table === undefined) {
    throw new PersistenceError({
      message: `generated mutation table not found: ${tableName}`,
    });
  }
  return table;
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
      : recordValue(values, name, `${prefix}${name}`);
    row[`${prefix}${name}`] = serializeAbiValue(param.type, value);
  }
  return row;
}

function prefixedObjectValues(
  prefix: string,
  value: unknown,
): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new PersistenceError({
      message: `generated mutation persistence expected object value for ${prefix.slice(0, -1)}`,
    });
  }
  const row: Record<string, unknown> = {};
  for (const [name, entry] of Object.entries(value)) {
    row[`${prefix}${name}`] = serializeJsonValue(entry);
  }
  return row;
}

function recordValue(value: unknown, key: string, column: string): unknown {
  if (!isRecord(value) || value[key] === undefined) {
    throw new PersistenceError({
      message: `generated mutation value missing for column: ${column}`,
    });
  }
  return value[key];
}

function requiredValue<T>(value: T | undefined, name: string): T {
  if (value === undefined) {
    throw new PersistenceError({
      message: `generated mutation persistence missing ${name}`,
    });
  }
  return value;
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
