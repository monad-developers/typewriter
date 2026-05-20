import type { PgTable } from "drizzle-orm/pg-core";
import { getTableName } from "drizzle-orm/table";
import { Data, Effect } from "effect";
import type { FFCAConfig, FFCADatabaseTransaction } from "./config";
import { Database } from "./db";
import type { AnchoredBundle, BundleEvent, ResolvedMutation } from "./types";

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

export function persistAcceptedBundle(
  bundle: Extract<BundleEvent, { status: "accepted" }>,
): Effect.Effect<void, unknown, Database> {
  return Effect.gen(function* () {
    const db = yield* Database;
    yield* db.transaction((tx: FFCADatabaseTransaction) =>
      Effect.gen(function* () {
        for (const [mutationIndex, mutation] of bundle.mutations.entries()) {
          if (mutation.config.persistMutation !== undefined) {
            yield* mutation.config.persistMutation(tx, {
              mutation,
              bundle: { id: bundle.id, mutationIndex },
            });
          }
          if (mutation.config.persistState !== undefined) {
            yield* mutation.config.persistState(tx, { mutation });
          }
        }
      }),
    );
  });
}

export function persistIncludedBundles(params: {
  readonly bundles: readonly AnchoredBundle[];
  readonly block: { number: bigint; hash: `0x${string}`; timestamp: bigint };
  readonly transactionHash: `0x${string}`;
  readonly calldata: `0x${string}`;
}): Effect.Effect<void, unknown, Database> {
  return Effect.gen(function* () {
    const db = yield* Database;
    yield* db.transaction((tx: FFCADatabaseTransaction) =>
      Effect.gen(function* () {
        for (const bundle of params.bundles) {
          for (const mutation of bundle.mutations) {
            if (mutation.config.persistLifecycle !== undefined) {
              yield* mutation.config.persistLifecycle(tx, {
                lifecycle: "included",
                mutation: mutation as Extract<
                  ResolvedMutation,
                  { status: "included" }
                >,
                block: {
                  ...params.block,
                  transactionHash: params.transactionHash,
                },
                calldata: params.calldata,
              });
            }
          }
        }
      }),
    );
  });
}

export function persistBlockLifecycle(
  block: Exclude<import("./types").BlockEvent, { status: "accepted" }>,
): Effect.Effect<void, unknown, Database> {
  return Effect.gen(function* () {
    if (block.status !== "safe" && block.status !== "finalized") return;
    const db = yield* Database;
    yield* db.transaction((tx: FFCADatabaseTransaction) =>
      Effect.gen(function* () {
        for (const bundle of block.bundles) {
          for (const mutation of bundle.mutations) {
            if (block.status === "safe") {
              if (mutation.config.persistLifecycle !== undefined) {
                yield* mutation.config.persistLifecycle(tx, {
                  lifecycle: "safe",
                  mutation: mutation as Extract<
                    ResolvedMutation,
                    { status: "safe" }
                  >,
                });
              }
            } else {
              if (mutation.config.persistLifecycle !== undefined) {
                yield* mutation.config.persistLifecycle(tx, {
                  lifecycle: "finalized",
                  mutation: mutation as Extract<
                    ResolvedMutation,
                    { status: "finalized" }
                  >,
                });
              }
            }
          }
        }
      }),
    );
  });
}
