import { type AbiParametersToColumns, abiParametersToColumns } from "abipg";
import {
  type AnyPgColumnBuilder,
  char,
  index,
  integer,
  numeric,
  type PgBuildColumns,
  type PgTableWithColumns,
  pgEnum,
  pgTable,
  serial,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import type { PgTable } from "drizzle-orm/pg-core/table";
import type { Hex } from "ox";
import type { MutationsConfig, SignatureConfig } from "./config";

const uint256 = () => numeric({ precision: 78, scale: 0, mode: "bigint" });
const bytes32 = () => char({ length: 66 }).$type<Hex.Hex>();

// TODO: make migration discover enum objects from generated schema instead of
// importing this singleton directly.
export const mutationStatusEnum = pgEnum("mutation_status", [
  "accepted",
  "included",
  "safe",
  "finalized",
]);

const mutationColumns = () => ({
  id: integer().notNull().primaryKey(),
  executionIndex: uint256(),
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

export type FFCAStateSchema = {
  readonly [Name in keyof ReturnType<typeof stateTables>]: ReturnType<
    typeof stateTables
  >[Name];
};

export type FFCASchema<
  mutationsConfig extends MutationsConfig = MutationsConfig,
  signatureConfig extends SignatureConfig = SignatureConfig,
> = FFCAStateSchema & FFCAMutationSchema<mutationsConfig, signatureConfig>;

export type FFCAMutationSchema<
  mutationsConfig extends MutationsConfig,
  signatureConfig extends SignatureConfig = SignatureConfig,
> = {
  readonly [name in keyof mutationsConfig as MutationTableName<
    name & string
  >]: MutationTable<
    MutationTableName<name & string>,
    mutationsConfig[name],
    signatureConfig
  >;
};

type MutationTableName<name extends string> = `${Lowercase<name>}_mutations`;

type ColumnGroup = Record<string, AnyPgColumnBuilder>;

type PrefixColumnNames<Columns, prefix extends string> = {
  readonly [name in keyof Columns &
    string as `${prefix}${name}`]: Columns[name] extends AnyPgColumnBuilder
    ? Columns[name]
    : never;
};

type ColumnGroupFrom<Columns> = {
  readonly [name in keyof Columns &
    string]: Columns[name] extends AnyPgColumnBuilder ? Columns[name] : never;
};

type MutationTableColumns<
  mutationConfig extends MutationsConfig[string],
  signatureConfig extends SignatureConfig,
> = ColumnGroupFrom<
  ReturnType<typeof mutationColumns> &
    AbiParametersToColumns<mutationConfig["params"]> &
    PrefixColumnNames<AbiParametersToColumns<signatureConfig>, "signature_">
>;

type MutationTable<
  tableName extends string,
  mutationConfig extends MutationsConfig[string],
  signatureConfig extends SignatureConfig,
> = PgTableWithColumns<{
  name: tableName;
  schema: undefined;
  columns: PgBuildColumns<
    tableName,
    MutationTableColumns<mutationConfig, signatureConfig>
  >;
  dialect: "pg";
}>;

export function createMutationSchema<
  const mutationsConfig extends MutationsConfig,
  const signatureConfig extends SignatureConfig,
>(config: {
  readonly signature: { readonly params: signatureConfig };
  readonly mutations: mutationsConfig;
}): FFCASchema<mutationsConfig, signatureConfig> {
  const signatureColumns = prefixColumnNames(
    abiParametersToColumns(config.signature.params) as ColumnGroup,
    "signature_",
  );
  const schema: Record<string, PgTable> = stateTables();

  for (const [name, mutation] of Object.entries(config.mutations)) {
    const tableName = mutationTableName(name);
    schema[tableName] = pgTable(
      tableName,
      mergeColumns(
        mutationColumns(),
        abiParametersToColumns(mutation.params),
        signatureColumns,
      ),
    );
  }

  return schema as FFCASchema<mutationsConfig, signatureConfig>;
}

function mutationTableName(name: string): `${Lowercase<string>}_mutations` {
  return `${name.toLowerCase()}_mutations` as `${Lowercase<string>}_mutations`;
}

function prefixColumnNames<
  const prefix extends string,
  Columns extends Record<string, AnyPgColumnBuilder>,
>(columns: Columns, prefix: prefix): PrefixColumnNames<Columns, prefix> {
  const prefixed: Record<string, AnyPgColumnBuilder> = {};
  for (const [name, column] of Object.entries(columns) as [
    string,
    AnyPgColumnBuilder,
  ][]) {
    prefixed[`${prefix}${name}`] = column;
  }
  return prefixed as PrefixColumnNames<Columns, prefix>;
}

function mergeColumns(...groups: readonly ColumnGroup[]): ColumnGroup {
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
