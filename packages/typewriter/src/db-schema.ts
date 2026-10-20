import { type AbiParametersToColumns, abiParametersToColumns } from "abipg";
import type { BuildColumns } from "drizzle-orm";
import {
  bigint,
  char,
  integer,
  numeric,
  type PgColumnBuilderBase,
  type PgTableWithColumns,
  pgTable,
  primaryKey,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import type { PgTable } from "drizzle-orm/pg-core/table";
import type { Hex } from "ox";
import type { MutationsConfig } from "./config";

const uint256 = () => numeric({ precision: 78, scale: 0, mode: "bigint" });
const bytes32 = () => char({ length: 66 }).$type<Hex.Hex>();

const mutationColumns = () => ({
  /** Position of the mutation in the onchain execution order. */
  execution_index: bigint({ mode: "bigint" }).notNull().primaryKey(),
  accepted_at: timestamp({ withTimezone: true }).notNull().defaultNow(),
  block_number: bigint({ mode: "bigint" }),
  block_hash: bytes32(),
  block_timestamp: bigint({ mode: "bigint" }),
  transaction_index: integer(),
  transaction_hash: bytes32(),
});

const authorizationColumns = () => ({
  authorization_account_id: bytes32().notNull(),
  authorization_credential_id: bigint({ mode: "bigint" }).notNull(),
  authorization_nonce: uint256().notNull(),
  authorization_expiration: bigint({ mode: "bigint" }).notNull(),
  authorization_signature: text().$type<Hex.Hex>().notNull(),
});

export const storageSlots = pgTable(
  "storage_slots",
  {
    execution_index: bigint({ mode: "bigint" }).notNull(),
    slot: bytes32().notNull(),
    value: bytes32().notNull(),
  },
  // TODO(kyle) revisit indexes once db-query is finalized
  (table) => [primaryKey({ columns: [table.slot, table.execution_index] })],
);

export const keccakPreimages = pgTable("keccak_preimages", {
  preimage: char({ length: 130 }).$type<Hex.Hex>().notNull().primaryKey(),
});

export function createMutationSchema<
  const mutationsConfig extends MutationsConfig,
>(config: {
  readonly mutations: mutationsConfig;
}): TypewriterMutationSchema<mutationsConfig> {
  const schema: Record<string, PgTable> = {};

  for (const [name, mutation] of Object.entries(config.mutations)) {
    const tableName = `${name.toLowerCase()}_mutations`;
    schema[tableName] = pgTable(
      tableName,
      mergeColumns(
        mutationColumns(),
        authorizationColumns(),
        abiParametersToColumns(mutation.params),
      ),
    );
  }

  return schema as TypewriterMutationSchema<mutationsConfig>;
}

function mergeColumns(...groups: readonly ColumnGroup[]): ColumnGroup {
  const columns: Record<string, PgColumnBuilderBase> = {};
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

export type TypewriterMutationSchema<mutationsConfig extends MutationsConfig> =
  {
    readonly [name in keyof mutationsConfig as MutationTableName<
      name & string
    >]: MutationTable<MutationTableName<name & string>, mutationsConfig[name]>;
  };

type MutationTableName<name extends string> = `${Lowercase<name>}_mutations`;

type ColumnGroup = Record<string, PgColumnBuilderBase>;

type ColumnGroupFrom<Columns> = {
  readonly [name in keyof Columns &
    string]: Columns[name] extends PgColumnBuilderBase ? Columns[name] : never;
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
  columns: BuildColumns<tableName, MutationTableColumns<mutationConfig>, "pg">;
  dialect: "pg";
}>;
