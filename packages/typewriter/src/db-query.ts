import { abiParametersToValues } from "abipg";
import { desc, getTableColumns, gte, inArray, sql } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";
import type { Hex } from "ox";
import type { AccountStorage } from "storage-layout";
import type { ExecuteResult } from "typewriter-evm";
import type { createTypewriterSchema } from "./db-schema";
import { builder } from "./db-transport";
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
  schema: Record<string, PgTable>,
  mutations: readonly AcceptedMutation[],
) {
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

  return [...rowsByTable.values()].flatMap(({ table, rows }) =>
    chunkRows(rows).map((batch) => builder.insert(table).values(batch)),
  );
}

function mutationRow(mutation: AcceptedMutation): Record<string, unknown> {
  const { authorization } = mutation;
  return {
    execution_index: mutation.executionIndex,
    authorization_account_id: authorization.accountID,
    authorization_credential_id: authorization.credentialID,
    authorization_nonce: authorization.nonce.toString(),
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
  schema: Record<string, PgTable>,
  mutations: readonly Pick<AcceptedMutation, "name" | "executionIndex">[],
  inclusion: Inclusion,
) {
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

  return [...indexesByTable].flatMap(([table, indexes]) => {
    const { execution_index } = getTableColumns(table);
    const statements = [];
    for (let i = 0; i < indexes.length; i += size) {
      const batch = indexes.slice(i, i + size);
      statements.push(
        builder
          .update(table)
          .set(values)
          .where(inArray(execution_index!, batch)),
      );
    }
    return statements;
  });
}

/**
 * Delete the mutation rows and storage slots from `executionIndex` on, so the
 * mutations that execute again in their place can insert theirs.
 */
export function deleteExecutionsFrom(
  schema: Record<string, PgTable>,
  { storageSlots }: ReturnType<typeof createTypewriterSchema>,
  executionIndex: bigint,
) {
  return [...Object.values(schema), storageSlots].map((table) => {
    const { execution_index } = getTableColumns(table);
    return builder.delete(table).where(gte(execution_index!, executionIndex));
  });
}

/** The largest execution index over all mutation tables, `null` if they are empty. */
export function selectMaxExecutionIndex(schema: Record<string, PgTable>) {
  const tables = Object.values(schema);
  // One `max` per table, so each uses its primary key index.
  const maxes =
    tables.length === 0
      ? sql`SELECT NULL AS max`
      : sql.join(
          tables.map((table) => {
            const { execution_index } = getTableColumns(table);
            return sql`SELECT max(${execution_index}) AS max FROM ${table}`;
          }),
          sql` UNION ALL `,
        );
  return builder.execute<{ max: bigint | null }>(
    sql`SELECT max(max) AS max FROM (${maxes}) AS mutations`,
  );
}

export function insertStorageSlots(
  { storageSlots }: ReturnType<typeof createTypewriterSchema>,
  mutationsWithResults: readonly {
    mutation: Pick<AcceptedMutation, "executionIndex">;
    executeResult: Pick<ExecuteResult, "slot_writes">;
  }[],
) {
  const rows = mutationsWithResults.flatMap(({ mutation, executeResult }) =>
    executeResult.slot_writes.map((write) => ({
      execution_index: mutation.executionIndex,
      slot: write.slot,
      value: write.value,
    })),
  );
  return chunkRows(rows).map((batch) =>
    builder.insert(storageSlots).values(batch),
  );
}

export function insertKeccakPreimages(
  { keccakPreimages }: ReturnType<typeof createTypewriterSchema>,
  preimages: readonly Hex.Hex[],
) {
  const rows = preimages.map((preimage) => ({ preimage }));
  return chunkRows(rows).map((batch) =>
    builder.insert(keccakPreimages).values(batch).onConflictDoNothing(),
  );
}

export function selectStorageSlots({
  storageSlots,
}: ReturnType<typeof createTypewriterSchema>) {
  return builder
    .selectDistinctOn([storageSlots.slot], {
      slot: storageSlots.slot,
      value: storageSlots.value,
    })
    .from(storageSlots)
    .orderBy(desc(storageSlots.slot), desc(storageSlots.execution_index));
}

export function accountStorage(
  rows: readonly { slot: Hex.Hex; value: Hex.Hex }[],
): AccountStorage {
  const storage: AccountStorage = {};
  for (const row of rows) {
    storage[row.slot] = row.value;
  }
  return storage;
}

export function selectKeccakPreimages({
  keccakPreimages,
}: ReturnType<typeof createTypewriterSchema>) {
  return builder
    .select({ preimage: keccakPreimages.preimage })
    .from(keccakPreimages);
}

function getMutationTable(
  schema: Record<string, PgTable>,
  mutationName: string,
): PgTable {
  return schema[`${mutationName.toLowerCase()}_mutations`]!;
}

/** Takes the schema's writes: a `fence` with an older epoch fails from now on. */
export function claimOwnership({
  typewriterMetadata,
}: ReturnType<typeof createTypewriterSchema>) {
  return builder
    .update(typewriterMetadata)
    .set({ owner_epoch: sql`${typewriterMetadata.owner_epoch} + 1` })
    .returning({
      owner_epoch: typewriterMetadata.owner_epoch,
      batch_seq: typewriterMetadata.batch_seq,
    });
}

/**
 * Advances `batch_seq` to `seq`. It fails the transaction unless `epoch` still
 * owns the schema and the batch before `seq` committed.
 */
export function fence(schemaName: string, epoch: bigint, seq: bigint) {
  return builder.execute(
    sql`SELECT ${sql.identifier(schemaName)}.typewriter_fence(${epoch}, ${seq})`,
  );
}

export function selectFence({
  typewriterMetadata,
}: ReturnType<typeof createTypewriterSchema>) {
  return builder
    .select({
      owner_epoch: typewriterMetadata.owner_epoch,
      batch_seq: typewriterMetadata.batch_seq,
    })
    .from(typewriterMetadata);
}
