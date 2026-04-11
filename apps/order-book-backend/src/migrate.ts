import {
  type DrizzleSnapshotJSON,
  generateDrizzleJson,
  generateMigration,
} from "drizzle-kit/api";
import { and, eq, sql } from "drizzle-orm";
import type { BunSQLDatabase } from "drizzle-orm/bun-sql";
import { migrate as drizzleMigrate } from "drizzle-orm/bun-sql/migrator";
import type { Address } from "viem";
import * as appSchema from "./app-schema";
import { deployments } from "./deployment-schema";

export async function migrate(
  db: BunSQLDatabase,
  chainId: number,
  contractAddress: Address,
) {
  await drizzleMigrate(db, { migrationsFolder: "./drizzle" });

  const [existing] = await db
    .select()
    .from(deployments)
    .where(
      and(
        eq(deployments.chainId, chainId),
        eq(deployments.contractAddress, contractAddress.toLowerCase()),
      ),
    )
    .limit(1);

  if (existing) {
    await db.execute(
      sql.raw(`SET search_path = ${existing.schemaName}, public`),
    );
    return;
  }

  const [{ max }] = await db
    .select({ max: sql<number>`coalesce(max(id), 0)` })
    .from(deployments);
  const schemaName = `d_${max + 1}`;

  const empty: DrizzleSnapshotJSON = generateDrizzleJson(
    {},
    undefined,
    undefined,
    "snake_case",
  );
  const target: DrizzleSnapshotJSON = generateDrizzleJson(
    appSchema,
    undefined,
    undefined,
    "snake_case",
  );
  const statements = await generateMigration(empty, target);

  await db.transaction(async (tx) => {
    await tx.execute(sql.raw(`CREATE SCHEMA IF NOT EXISTS ${schemaName}`));
    await tx.execute(sql.raw(`SET LOCAL search_path = ${schemaName}, public`));

    for (const stmt of statements) {
      await tx.execute(sql.raw(stmt.replaceAll('"public".', "")));
    }

    await tx.execute(sql.raw("SET LOCAL search_path = public"));
    await tx.insert(deployments).values({
      schemaName,
      contractAddress: contractAddress.toLowerCase(),
      chainId,
      blockNumber: 0,
    });
  });

  console.log(`Schema ${schemaName} ready`);

  await db.execute(sql.raw(`SET search_path = ${schemaName}, public`));
}
