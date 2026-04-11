import {
  bigint,
  char,
  integer,
  pgTable,
  serial,
  text,
  timestamp,
  unique,
} from "drizzle-orm/pg-core";

export const deployments = pgTable(
  "deployments",
  {
    id: serial().primaryKey(),
    schemaName: text().notNull().unique(),
    contractAddress: char({ length: 42 }).notNull(),
    chainId: integer().notNull(),
    blockNumber: bigint({ mode: "number" }).notNull(),
    createdAt: timestamp().notNull().defaultNow(),
  },
  (t) => [unique().on(t.contractAddress, t.chainId)],
);
