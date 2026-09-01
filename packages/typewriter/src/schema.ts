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
import type { MutationsConfig } from "./config";

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

const authorizationColumns = () => ({
  authorization_account_id: bytes32().notNull(),
  authorization_credential_id: numeric({
    precision: 20,
    scale: 0,
    mode: "bigint",
  }).notNull(),
  authorization_nonce: uint256().notNull(),
  authorization_expiration: uint256().notNull(),
  authorization_signature: text().$type<Hex.Hex>().notNull(),
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

export type TypewriterStateSchema = {
  readonly [Name in keyof ReturnType<typeof stateTables>]: ReturnType<
    typeof stateTables
  >[Name];
};

export type TypewriterSchema<
  mutationsConfig extends MutationsConfig = MutationsConfig,
> = TypewriterStateSchema & TypewriterMutationSchema<mutationsConfig>;

export type TypewriterMutationSchema<mutationsConfig extends MutationsConfig> =
  {
    readonly [name in keyof mutationsConfig as MutationTableName<
      name & string
    >]: MutationTable<MutationTableName<name & string>, mutationsConfig[name]>;
  };

type MutationTableName<name extends string> = `${Lowercase<name>}_mutations`;

type ColumnGroup = Record<string, AnyPgColumnBuilder>;

type ColumnGroupFrom<Columns> = {
  readonly [name in keyof Columns &
    string]: Columns[name] extends AnyPgColumnBuilder ? Columns[name] : never;
};

type MutationTableColumns<mutationConfig extends MutationsConfig[string]> =
  ColumnGroupFrom<
    ReturnType<typeof mutationColumns> &
      AbiParametersToColumns<mutationConfig["params"]> &
      ReturnType<typeof authorizationColumns>
  >;

type MutationTable<
  tableName extends string,
  mutationConfig extends MutationsConfig[string],
> = PgTableWithColumns<{
  name: tableName;
  schema: undefined;
  columns: PgBuildColumns<tableName, MutationTableColumns<mutationConfig>>;
  dialect: "pg";
}>;

export function createMutationSchema<
  const mutationsConfig extends MutationsConfig,
>(config: {
  readonly mutations: mutationsConfig;
}): TypewriterSchema<mutationsConfig> {
  const schema: Record<string, PgTable> = stateTables();

  for (const [name, mutation] of Object.entries(config.mutations)) {
    const tableName = mutationTableName(name);
    schema[tableName] = pgTable(
      tableName,
      mergeColumns(
        mutationColumns(),
        abiParametersToColumns(mutation.params),
        authorizationColumns(),
      ),
    );
  }

  return schema as TypewriterSchema<mutationsConfig>;
}

function mutationTableName(name: string): `${Lowercase<string>}_mutations` {
  return `${name.toLowerCase()}_mutations` as `${Lowercase<string>}_mutations`;
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
