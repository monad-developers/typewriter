import type { PgTable } from "drizzle-orm/pg-core";
import { getTableName } from "drizzle-orm/table";
import { Data, Effect } from "effect";
import type { FFCAConfig, FFCADatabaseTransaction } from "./config";
import { Database } from "./db";
import type { ResolvedMutation, RuntimeBundle, RuntimeMutation } from "./types";

export class PersistenceError extends Data.TaggedError("PersistenceError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

function hasAllPersistenceHooks(mutation: FFCAConfig["mutations"][string]) {
  return (
    mutation.persistMutation !== undefined &&
    mutation.persistState !== undefined &&
    mutation.persistLifecycle !== undefined
  );
}

function hasAnyPersistenceHook(mutation: FFCAConfig["mutations"][string]) {
  return (
    mutation.persistMutation !== undefined ||
    mutation.persistState !== undefined ||
    mutation.persistLifecycle !== undefined
  );
}

export function getFFCASchema(config: FFCAConfig): Record<string, PgTable> {
  const schema = { ...(config.state?.schema ?? {}) } as Record<string, PgTable>;
  for (const mutation of Object.values(config.mutations)) {
    const table = mutation.table as PgTable;
    if (Object.values(schema).includes(table)) continue;
    schema[getTableName(table)] = table;
  }
  return schema;
}

export function isPersistenceEnabled(config: FFCAConfig): boolean {
  const mutations = Object.values(config.mutations);
  const hasStateSchema = config.state?.schema !== undefined;
  const hasStateLoad = config.state?.load !== undefined;
  const hasAnyHooks = mutations.some(hasAnyPersistenceHook);
  const hasAllHooks = mutations.every(hasAllPersistenceHooks);
  const persistenceEnabled = hasStateSchema && hasStateLoad && hasAllHooks;
  const persistenceDisabled = !hasStateSchema && !hasStateLoad && !hasAnyHooks;

  if (persistenceDisabled) return false;
  if (!persistenceEnabled) {
    throw new PersistenceError({
      message:
        "FFCA persistence must be fully configured: state.schema, state.load, and all mutation persistence hooks are required together",
    });
  }

  return true;
}

export function persistMutation(
  mutation: ResolvedMutation,
  bundle: RuntimeBundle,
): Effect.Effect<void, unknown, Database> {
  return Effect.gen(function* () {
    const db = yield* Database;
    yield* db.transaction((tx: FFCADatabaseTransaction) =>
      Effect.gen(function* () {
        if (mutation.config.persistMutation !== undefined) {
          yield* mutation.config.persistMutation(tx, {
            mutation,
            bundle,
          });
        }

        if (mutation.config.persistState !== undefined) {
          yield* mutation.config.persistState(tx, { mutation });
        }
      }),
    );
  });
}

export function persistUpdatedMutationLifecycle(
  mutation: Extract<
    RuntimeMutation,
    { status: "accepted" | "included" | "safe" | "finalized" }
  >,
): Effect.Effect<void, unknown, Database> {
  return Effect.gen(function* () {
    const db = yield* Database;
    yield* db.transaction((tx: FFCADatabaseTransaction) =>
      Effect.gen(function* () {
        if (mutation.config.persistLifecycle === undefined) return;

        yield* mutation.config.persistLifecycle(tx, {
          // @ts-expect-error
          lifecycle: mutation.status,
          // @ts-expect-error
          mutation,
        });
      }),
    );
  });
}
