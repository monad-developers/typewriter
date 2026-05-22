import { abiParametersToColumns } from "abipg";
import {
  type AnyPgColumnBuilder,
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

const uint256 = () => numeric({ precision: 78, scale: 0 });
const bytes32 = () => char({ length: 66 });

// TODO: make migration discover enum objects from generated schema instead of
// importing this singleton directly.
export const mutationStatusEnum = pgEnum("mutation_status", [
  "accepted",
  "included",
  "safe",
  "finalized",
]);

// Persisted mutation rows start at "accepted". Submitted mutations live only in
// memory until the runtime accepts them.
const mutationColumns = () => ({
  id: integer().notNull().primaryKey(),
  bundleId: integer().notNull(),
  bundlePosition: integer().notNull(),
  blockNumber: uint256(),
  blockHash: bytes32(),
  blockTimestamp: uint256(),
  transactionHash: bytes32(),
  status: mutationStatusEnum().notNull(),
  acceptedAt: timestamp().notNull().defaultNow(),
  includedAt: timestamp(),
  safeAt: timestamp(),
  finalizedAt: timestamp(),
});

type GeneratedMutationSchema<Config extends FFCAConfig = FFCAConfig> = {
  readonly [Name in keyof Config["mutations"] as `${Lowercase<Name & string>}_mutations`]: PgTable;
};

export function createMutationSchema<const Config extends FFCAConfig>(
  config: Pick<Config, "abi" | "mutations">,
): GeneratedMutationSchema<Config> {
  const signatureColumns = prefixColumnNames(
    abiParametersToColumns(getSignatureAbiParameters(config.abi)),
    "signature_",
  );
  const schema: Record<string, PgTable> = {};

  for (const [name, mutation] of Object.entries(config.mutations)) {
    const tableName = mutationTableName(name);
    const resolutionColumns =
      "resolution" in mutation
        ? prefixColumnNames(
            abiParametersToColumns(mutation.resolution),
            "resolution_",
          )
        : {};

    schema[tableName] = pgTable(
      tableName,
      mergeColumns(
        mutationColumns(),
        abiParametersToColumns(mutation.params),
        signatureColumns,
        resolutionColumns,
      ),
    );
  }

  return schema as GeneratedMutationSchema<Config>;
}

function mutationTableName(name: string): `${Lowercase<string>}_mutations` {
  return `${name.toLowerCase()}_mutations` as `${Lowercase<string>}_mutations`;
}

function prefixColumnNames<Columns extends Record<string, AnyPgColumnBuilder>>(
  columns: Columns,
  prefix: string,
): Record<string, AnyPgColumnBuilder> {
  const prefixed: Record<string, AnyPgColumnBuilder> = {};
  for (const [name, column] of Object.entries(columns)) {
    prefixed[`${prefix}${name}`] = column;
  }
  return prefixed;
}

function mergeColumns(
  ...groups: readonly Record<string, AnyPgColumnBuilder>[]
): Record<string, AnyPgColumnBuilder> {
  const columns: Record<string, AnyPgColumnBuilder> = {};
  for (const group of groups) {
    for (const [name, column] of Object.entries(group)) {
      if (columns[name] !== undefined) {
        throw new Error(`duplicate generated mutation column name: ${name}`);
      }
      columns[name] = column;
    }
  }
  return columns;
}
