import { count, desc, eq, gte } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sql";
import type { Hex } from "viem";
import { app, databaseUrl } from "./app";

const db = drizzle({ client: new Bun.SQL({ url: databaseUrl, max: 25 }) });
const tables = Object.values(app.schema);

export async function selectBlock(blockNumber: bigint) {
  for (const table of tables) {
    const [row] = await db
      .select({
        blockNumber: table.block_number,
        blockHash: table.block_hash,
        blockTimestamp: table.block_timestamp,
      })
      .from(table)
      .where(eq(table.block_number, blockNumber))
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

export async function selectMutationsByBlock(blockNumber: bigint) {
  const rows = await Promise.all(
    tables.map((table) =>
      db.select().from(table).where(eq(table.block_number, blockNumber)),
    ),
  );
  return rows
    .flat()
    .sort((a, b) => compareBigInt(a.execution_index, b.execution_index));
}

export async function selectMutationByExecutionIndex(executionIndex: bigint) {
  for (const table of tables) {
    const [row] = await db
      .select()
      .from(table)
      .where(eq(table.execution_index, executionIndex))
      .limit(1);
    if (row !== undefined) return row;
  }
  return null;
}

export async function selectMutationsByAccount(account: Hex, limit: number) {
  const rows = await Promise.all(
    tables.map((table) =>
      db
        .select()
        .from(table)
        .where(eq(table.authorization_account_id, account))
        .orderBy(desc(table.execution_index))
        .limit(limit),
    ),
  );
  return rows
    .flat()
    .sort((a, b) => compareBigInt(b.execution_index, a.execution_index))
    .slice(0, limit);
}

export async function selectRecentMutationCount(windowMs: number) {
  const counts = await Promise.all(
    tables.map(async (table) => {
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
