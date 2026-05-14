import { char, integer, numeric, pgEnum, timestamp } from "drizzle-orm/pg-core";

// const uint8 = () => smallint();
// const uint16 = () => integer();
// const uint32 = () => bigint({ mode: "number" });
// const uint40 = () => bigint({ mode: "number" });
// const uint64 = () => bigint({ mode: "bigint" });
const uint256 = () => numeric({ precision: 78, scale: 0 });
const bytes32 = () => char({ length: 66 });

export const mutationStatusEnum = pgEnum("mutation_status", [
  "accepted",
  "proposed",
  "voted",
  "finalized",
  "verified",
]);

// Shared column builders for app-owned mutation tables. FFCA does not provide
// built-in tables for apps to join against; apps spread these columns into the
// tables they own, then add their own signature/account/payload columns.
//
// Persisted mutation rows start at "accepted". Pending mutations live only in
// memory and are not part of the database model.
export const mutationColumns = () => ({
  // Runtime-assigned, globally unique across every table that spreads these
  // columns. `loadNextIds` resumes from the max id across all mutation tables
  // on restart, so apps must not assign their own values.
  id: integer().notNull().primaryKey(),
  bundleId: integer(),
  bundlePosition: integer(),
  blockNumber: uint256(),
  blockHash: bytes32(),
  blockTimestamp: uint256(),
  transactionHash: bytes32(),

  // Lifecycle tracking. `acceptedAt` is set on insert by the column default;
  // `persistLifecycle` writes the matching `*At` column when the runtime
  // advances a mutation through proposed → voted → finalized → verified.
  status: mutationStatusEnum().notNull(),
  acceptedAt: timestamp().notNull().defaultNow(),
  proposedAt: timestamp(),
  votedAt: timestamp(),
  finalizedAt: timestamp(),
  verifiedAt: timestamp(),
});
