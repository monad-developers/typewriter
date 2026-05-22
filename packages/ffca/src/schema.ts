import { abiParametersToColumns } from "abipg";
import type { AbiParameter } from "abitype";
import {
  char,
  integer,
  numeric,
  pgEnum,
  pgTable,
  timestamp,
} from "drizzle-orm/pg-core";
import type { PgTable } from "drizzle-orm/pg-core/table";
import type { FFCAConfig } from "./config";
import { getSignatureAbiParameters } from "./encoding";

// const uint8 = () => smallint();
// const uint16 = () => integer();
// const uint32 = () => bigint({ mode: "number" });
// const uint40 = () => bigint({ mode: "number" });
// const uint64 = () => bigint({ mode: "bigint" });
const uint256 = () => numeric({ precision: 78, scale: 0 });
const bytes32 = () => char({ length: 66 });

export const mutationStatusEnum = pgEnum("mutation_status", [
  "accepted",
  "included",
  "safe",
  "finalized",
]);

// Shared column builders for app-owned mutation tables. FFCA does not provide
// built-in tables for apps to join against; apps spread these columns into the
// tables they own, then add their own signature/account/payload columns.
//
// Persisted mutation rows start at "accepted". Submitted mutations live only
// in memory and are not part of the database model.
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
  // advances a mutation through included → safe → finalized.
  status: mutationStatusEnum().notNull(),
  acceptedAt: timestamp().notNull().defaultNow(),
  includedAt: timestamp(),
  safeAt: timestamp(),
  finalizedAt: timestamp(),
});

export type GeneratedMutationSchema<Config extends FFCAConfig = FFCAConfig> = {
  readonly [Name in keyof Config["mutations"] as `${Lowercase<Name & string>}_mutations`]: PgTable;
};

export function createMutationSchema<const Config extends FFCAConfig>(
  config: Pick<Config, "abi" | "mutations">,
): GeneratedMutationSchema<Config> {
  const signatureParams = prefixAbiParameters(
    getSignatureAbiParameters(config.abi),
    "signature_",
  );
  const schema: Record<string, PgTable> = {};

  for (const [name, mutation] of Object.entries(config.mutations)) {
    const tableName = mutationTableName(name);
    const params = [
      ...mutation.params,
      ...signatureParams,
      ...("resolution" in mutation
        ? prefixAbiParameters(mutation.resolution, "resolution_")
        : []),
    ] satisfies readonly AbiParameter[];

    schema[tableName] = pgTable(tableName, {
      ...mutationColumns(),
      ...abiParametersToColumns(params),
    });
  }

  return schema as GeneratedMutationSchema<Config>;
}

function mutationTableName(name: string): `${Lowercase<string>}_mutations` {
  return `${name.toLowerCase()}_mutations` as `${Lowercase<string>}_mutations`;
}

function prefixAbiParameters(
  params: readonly AbiParameter[],
  prefix: string,
): readonly AbiParameter[] {
  return params.map((param, index) => ({
    ...param,
    name: `${prefix}${param.name === undefined || param.name === "" ? `arg${index}` : param.name}`,
  }));
}
