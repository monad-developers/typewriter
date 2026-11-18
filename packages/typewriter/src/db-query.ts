import { abiParametersToValues } from "abipg";
import { desc, getTableColumns, gte, type SQL, sql } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";
import type { Hex } from "ox";
import type { AccountStorage } from "storage-layout";
import type { ExecuteResult } from "typewriter-evm";
import type { createTypewriterSchema } from "./db-schema";
import { builder } from "./db-transport";
import type {
  AcceptedMutation,
  IncludedMutation,
  RuntimeBlock,
} from "./typewriter-types";

/**
 * Inserts `rows` from one JSON parameter, so no parameter is built per row.
 * The JSON is sent as `text`, since Bun encodes a `json` parameter again.
 */
function insertRows(
  table: PgTable,
  rows: readonly Record<string, unknown>[],
  onConflict: SQL = sql``,
) {
  if (rows.length === 0) return [];
  const columns = sql.join(
    Object.keys(rows[0]!).map((column) => sql.identifier(column)),
    sql`, `,
  );
  const json = JSON.stringify(rows, (_, value) =>
    typeof value === "bigint" ? value.toString() : value,
  );
  return [
    builder.execute(
      sql`INSERT INTO ${table} (${columns}) SELECT ${columns} FROM json_populate_recordset(NULL::${table}, ${json}::text::json)${onConflict}`,
    ),
  ];
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
    insertRows(table, rows),
  );
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

/** Update all the receipts for a block in one statement per mutation table. */
export function includeBlockMutations(
  schema: Record<string, PgTable>,
  block: Pick<RuntimeBlock, "number" | "hash" | "timestamp">,
  mutations: readonly Pick<
    IncludedMutation,
    "name" | "executionIndex" | "transactionHash" | "transactionIndex"
  >[],
) {
  const tables = Map.groupBy(mutations, ({ name }) =>
    getMutationTable(schema, name),
  );
  return [...tables].map(([table, rows]) => {
    const transactions = Map.groupBy(
      rows,
      (mutation) => mutation.transactionIndex,
    );
    const receipts = [...transactions].map(([index, group]) => ({
      transaction_hash: group[0]!.transactionHash,
      transaction_index: index,
      indexes: group.map(({ executionIndex }) => String(executionIndex)),
    }));
    return builder.execute(sql`
    UPDATE ${table} AS mutation
    SET block_number = ${String(block.number)}::bigint, block_hash = ${block.hash},
        block_timestamp = ${String(block.timestamp)}::bigint,
        transaction_hash = receipt.transaction_hash, transaction_index = receipt.transaction_index
    FROM json_to_recordset(${JSON.stringify(receipts)}::text::json)
      AS receipt(transaction_hash text, transaction_index integer, indexes bigint[]),
      LATERAL unnest(receipt.indexes) AS item(execution_index)
    WHERE mutation.execution_index = item.execution_index
  `);
  });
}

/** Clear the inclusion columns for mutations whose block was removed. */
export function clearMutationInclusion(
  schema: Record<string, PgTable>,
  mutations: readonly Pick<AcceptedMutation, "name" | "executionIndex">[],
) {
  const tables = Map.groupBy(mutations, ({ name }) =>
    getMutationTable(schema, name),
  );
  return [...tables].map(([table, rows]) => {
    const indexes = rows.map(({ executionIndex }) => executionIndex);
    const { execution_index } = getTableColumns(table);
    return builder
      .update(table)
      .set({
        block_number: null,
        block_hash: null,
        block_timestamp: null,
        transaction_hash: null,
        transaction_index: null,
      })
      .where(
        sql`${execution_index} = ANY(${`{${indexes.join(",")}}`}::bigint[])`,
      );
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
  return insertRows(storageSlots, rows);
}

export function insertKeccakPreimages(
  { keccakPreimages }: ReturnType<typeof createTypewriterSchema>,
  preimages: readonly Hex.Hex[],
) {
  return insertRows(
    keccakPreimages,
    preimages.map((preimage) => ({ preimage })),
    sql` ON CONFLICT DO NOTHING`,
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
