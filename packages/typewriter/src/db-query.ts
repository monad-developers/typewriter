import { abiParametersToValues } from "abipg";
import { desc, getTableColumns, inArray, sql } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";
import { Effect } from "effect";
import type { Hex } from "ox";
import type { AccountStorage } from "storage-layout";
import type { ExecuteResult } from "typewriter-evm";
import type { DbError, DbTransaction } from "./db";
import type { createTypewriterSchema } from "./db-schema";
import type { AcceptedMutation, Inclusion } from "./typewriter-types";

/** Postgres protocol limit: 65535 bind parameters per query. */
const MAX_PG_PARAMS = 65_535;

/** Split insert rows into batches that stay under `MAX_PG_PARAMS`. */
function chunkRows<T extends Record<string, unknown>>(
  rows: readonly T[],
): T[][] {
  if (rows.length === 0) return [];
  const size = Math.floor(MAX_PG_PARAMS / Object.keys(rows[0]!).length);
  const chunks: T[][] = [];
  for (let i = 0; i < rows.length; i += size) {
    chunks.push(rows.slice(i, i + size));
  }
  return chunks;
}

export function insertMutations(
  tx: DbTransaction,
  schema: Record<string, PgTable>,
  mutations: readonly AcceptedMutation[],
): Effect.Effect<void, DbError> {
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
      for (const batch of chunkRows(rows)) {
        yield* tx.query((db) => db.insert(table).values(batch));
      }
    }
  });
}

function mutationRow(mutation: AcceptedMutation): Record<string, unknown> {
  const { authorization } = mutation;
  return {
    execution_index: mutation.executionIndex,
    authorization_account_id: authorization.accountID,
    authorization_credential_id: authorization.credentialID,
    authorization_nonce: authorization.nonce,
    authorization_expiration: authorization.expiration,
    authorization_signature: authorization.signature,
    ...abiParametersToValues(
      mutation.config.params,
      mutation.params as Parameters<typeof abiParametersToValues>[1],
    ),
  };
}

/**
 * Set the `block_*` and `transaction_*` columns of mutations that one
 * settlement transaction included. Running it again writes the same values.
 */
export function updateMutationInclusion(
  tx: DbTransaction,
  schema: Record<string, PgTable>,
  mutations: readonly Pick<AcceptedMutation, "name" | "executionIndex">[],
  inclusion: Inclusion,
): Effect.Effect<void, DbError> {
  return Effect.gen(function* () {
    const indexesByTable = new Map<PgTable, bigint[]>();
    for (const mutation of mutations) {
      const table = getMutationTable(schema, mutation.name);
      let indexes = indexesByTable.get(table);
      if (indexes === undefined) {
        indexes = [];
        indexesByTable.set(table, indexes);
      }
      indexes.push(mutation.executionIndex);
    }

    const values = {
      block_number: inclusion.blockNumber,
      block_hash: inclusion.blockHash,
      block_timestamp: inclusion.blockTimestamp,
      transaction_hash: inclusion.transactionHash,
      transaction_index: inclusion.transactionIndex,
    };
    // The `SET` values take bind parameters too.
    const size = MAX_PG_PARAMS - Object.keys(values).length;

    for (const [table, indexes] of indexesByTable) {
      const { execution_index } = getTableColumns(table);
      for (let i = 0; i < indexes.length; i += size) {
        const batch = indexes.slice(i, i + size);
        yield* tx.query((db) =>
          db.update(table).set(values).where(inArray(execution_index!, batch)),
        );
      }
    }
  });
}

/** The largest execution index over all mutation tables, or `undefined` if they are empty. */
export function selectMaxExecutionIndex(
  tx: DbTransaction,
  schema: Record<string, PgTable>,
): Effect.Effect<bigint | undefined, DbError> {
  return Effect.gen(function* () {
    const tables = Object.values(schema);
    if (tables.length === 0) return undefined;

    // One `max` per table, so each uses its primary key index.
    const maxes = sql.join(
      tables.map((table) => {
        const { execution_index } = getTableColumns(table);
        return sql`SELECT max(${execution_index}) AS max FROM ${table}`;
      }),
      sql` UNION ALL `,
    );
    const [{ max = null } = {}] = yield* tx.query((db) =>
      db.execute<{ max: string | null }>(
        sql`SELECT max(max) AS max FROM (${maxes}) AS mutations`,
      ),
    );
    return max === null ? undefined : BigInt(max);
  });
}

export function insertStorageSlots(
  tx: DbTransaction,
  { storageSlots }: ReturnType<typeof createTypewriterSchema>,
  mutationsWithResults: readonly {
    mutation: Pick<AcceptedMutation, "executionIndex">;
    executeResult: Pick<ExecuteResult, "slot_writes">;
  }[],
): Effect.Effect<void, DbError> {
  return Effect.gen(function* () {
    const rows = mutationsWithResults.flatMap(({ mutation, executeResult }) =>
      executeResult.slot_writes.map((write) => ({
        execution_index: mutation.executionIndex,
        slot: write.slot,
        value: write.new_value,
      })),
    );

    for (const batch of chunkRows(rows)) {
      yield* tx.query((db) => db.insert(storageSlots).values(batch));
    }
  });
}

export function insertKeccakPreimages(
  tx: DbTransaction,
  { keccakPreimages }: ReturnType<typeof createTypewriterSchema>,
  preimages: readonly Hex.Hex[],
): Effect.Effect<void, DbError> {
  return Effect.gen(function* () {
    const rows = preimages.map((preimage) => ({ preimage }));
    for (const batch of chunkRows(rows)) {
      yield* tx.query((db) =>
        db.insert(keccakPreimages).values(batch).onConflictDoNothing(),
      );
    }
  });
}

export function selectStorageSlots(
  tx: DbTransaction,
  { storageSlots }: ReturnType<typeof createTypewriterSchema>,
): Effect.Effect<AccountStorage, DbError> {
  return Effect.gen(function* () {
    const rows = yield* tx.query((db) =>
      db
        .selectDistinctOn([storageSlots.slot], {
          slot: storageSlots.slot,
          value: storageSlots.value,
        })
        .from(storageSlots)
        .orderBy(desc(storageSlots.slot), desc(storageSlots.execution_index)),
    );

    const storage: AccountStorage = {};
    for (const row of rows) {
      storage[row.slot] = row.value;
    }
    return storage;
  });
}

export function selectKeccakPreimages(
  tx: DbTransaction,
  { keccakPreimages }: ReturnType<typeof createTypewriterSchema>,
): Effect.Effect<Hex.Hex[], DbError> {
  return Effect.gen(function* () {
    const rows = yield* tx.query((db) =>
      db.select({ preimage: keccakPreimages.preimage }).from(keccakPreimages),
    );
    return rows.map((row) => row.preimage);
  });
}

function getMutationTable(
  schema: Record<string, PgTable>,
  mutationName: string,
): PgTable {
  return schema[`${mutationName.toLowerCase()}_mutations`]!;
}
