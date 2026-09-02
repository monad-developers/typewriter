import { count, desc, eq, gte } from "drizzle-orm";
import type { BunSQLDatabase } from "drizzle-orm/bun-sql/postgres";
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
        blockNumber: table.blockNumber,
        blockHash: table.blockHash,
        blockTimestamp: table.blockTimestamp,
      })
      .from(table)
      .where(eq(table.blockNumber, BigInt(blockNumber)))
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
        .where(eq(table.blockNumber, BigInt(blockNumber)));
    }),
  );
  return rows.flat().sort((a, b) => a.id - b.id);
}

export async function selectMutationById(
  db: QueryDatabase,
  schema: OrderBookSchema,
  id: number,
) {
  for (const mutationTableName of mutationTableNames) {
    const table = schema[mutationTableName];
    const rows = await db.select().from(table).where(eq(table.id, id)).limit(1);
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
        .orderBy(desc(table.id))
        .limit(limit);
    }),
  );
  return rows
    .flat()
    .sort((a, b) => b.id - a.id)
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
        .where(gte(table.acceptedAt, new Date(Date.now() - windowMs)));
      return row?.count ?? 0;
    }),
  );
  return counts.reduce((total, value) => total + value, 0);
}
