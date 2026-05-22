import { abiParametersToColumns } from "abipg";
import {
  type AnyPgColumnBuilder,
  char,
  index,
  integer,
  numeric,
  pgEnum,
  pgTable,
  serial,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import type { PgTable } from "drizzle-orm/pg-core/table";
import type { Hex } from "ox";
import type { FFCAConfig } from "./config";
import { getSignatureAbiParameters } from "./encoding";

const uint256 = () => numeric({ precision: 78, scale: 0 });
const bytes32 = () => char({ length: 66 }).$type<Hex.Hex>();

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

const stateTables = () => ({
  slot_writes: pgTable(
    "slot_writes",
    {
      id: serial().primaryKey(),
      mutationId: integer().notNull(),
      slot: bytes32().notNull(),
      value: bytes32().notNull(),
    },
    (table) => [
      index("slot_writes_latest_idx").on(table.slot, table.id.desc()),
    ],
  ),
  known_paths: pgTable("known_paths", {
    path: text().notNull().primaryKey(),
  }),
});

type StateSchema = {
  readonly [Name in keyof ReturnType<typeof stateTables>]: ReturnType<
    typeof stateTables
  >[Name];
};

type MutationSchema<Config extends FFCAConfig = FFCAConfig> = {
  readonly [Name in keyof Config["mutations"] as `${Lowercase<Name & string>}_mutations`]: PgTable;
};

export function createMutationSchema<const Config extends FFCAConfig>(
  config: Pick<Config, "abi" | "mutations">,
): StateSchema & MutationSchema<Config> {
  const signatureColumns = prefixColumnNames(
    abiParametersToColumns(getSignatureAbiParameters(config.abi)),
    "signature_",
  );
  const schema: Record<string, PgTable> = stateTables();

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

  return schema as StateSchema & MutationSchema<Config>;
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
        throw new Error(`duplicate mutation column name: ${name}`);
      }
      columns[name] = column;
    }
  }
  return columns;
}
