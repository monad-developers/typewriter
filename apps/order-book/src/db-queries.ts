import { count, desc, eq, gte } from "drizzle-orm";
import type { BunSQLDatabase } from "drizzle-orm/bun-sql";
import type { Hex } from "viem";

// biome-ignore lint/suspicious/noExplicitAny: generated Solidity schema types will replace this temporary dynamic schema access
type OrderBookSchema = any;
type QueryDatabase = BunSQLDatabase & { readonly $client: Bun.SQL };

const mutationTableNames = [
  "createaccount_mutations",
  "addcredential_mutations",
  "removecredential_mutations",
  "closeorder_mutations",
  "changeorder_mutations",
  "limitorder_mutations",
  "marketorder_mutations",
  "addinstrument_mutations",
  "deposit_mutations",
  "withdrawal_mutations",
] as const;

export async function selectBlock(
  db: QueryDatabase,
  schema: OrderBookSchema,
  blockNumber: string,
) {
  for (const mutationTableName of mutationTableNames) {
    const table = schema[mutationTableName];
    const [row] = await db
      .select({
        blockNumber: table.block_number,
        blockHash: table.block_hash,
        blockTimestamp: table.block_timestamp,
      })
      .from(table)
      .where(eq(table.block_number, BigInt(blockNumber)))
      .limit(1);
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

export async function selectMutationsByBlock(
  db: QueryDatabase,
  schema: OrderBookSchema,
  blockNumber: string,
) {
  const rows = await Promise.all(
    mutationTableNames.map(async (mutationTableName) => {
      const table = schema[mutationTableName];
      return await db
        .select()
        .from(table)
        .where(eq(table.block_number, BigInt(blockNumber)));
    }),
  );
  return rows
    .flat()
    .sort((a, b) => compareBigInt(a.execution_index, b.execution_index));
}

export async function selectMutationByExecutionIndex(
  db: QueryDatabase,
  schema: OrderBookSchema,
  executionIndex: bigint,
) {
  for (const mutationTableName of mutationTableNames) {
    const table = schema[mutationTableName];
    const rows = await db
      .select()
      .from(table)
      .where(eq(table.execution_index, executionIndex))
      .limit(1);
    if (rows.length > 0) return rows[0];
  }
  return null;
}

export async function selectMutationsByAccount(
  db: QueryDatabase,
  schema: OrderBookSchema,
  account: Hex,
  limit: number,
) {
  const rows = await Promise.all(
    mutationTableNames.map(async (mutationTableName) => {
      const table = schema[mutationTableName];
      return await db
        .select()
        .from(table)
        .where(eq(table.authorization_account_id, account))
        .orderBy(desc(table.execution_index))
        .limit(limit);
    }),
  );
  return rows
    .flat()
    .sort((a, b) => compareBigInt(b.execution_index, a.execution_index))
    .slice(0, limit);
}

export async function selectRecentMutationCount(
  db: QueryDatabase,
  schema: OrderBookSchema,
  windowMs: number,
) {
  const counts = await Promise.all(
    mutationTableNames.map(async (mutationTableName) => {
      const table = schema[mutationTableName];
      const [row] = await db
        .select({ count: count() })
        .from(table)
        .where(gte(table.accepted_at, new Date(Date.now() - windowMs)));
      return row?.count ?? 0;
    }),
  );
  return counts.reduce((total, value) => total + value, 0);
}

function compareBigInt(a: bigint, b: bigint): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
