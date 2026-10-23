import { type AbiParametersToColumns, abiParametersToColumns } from "abipg";
import type { BuildColumns } from "drizzle-orm";
import {
  bigint,
  char,
  integer,
  numeric,
  type PgColumnBuilderBase,
  type PgTableWithColumns,
  pgSchema,
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
  // TODO(kyle) `mode: "number"`, see `Credential` in `typewriter-types.ts`.
  authorization_expiration: bigint({ mode: "bigint" }).notNull(),
  authorization_signature: text().$type<Hex.Hex>().notNull(),
});

export const TYPEWRITER_SCHEMA_VERSION = 1;

export function createMutationSchema<
  const mutationsConfig extends MutationsConfig,
>(
  schemaName: string,
  config: {
    readonly mutations: mutationsConfig;
  },
): TypewriterMutationSchema<mutationsConfig> {
  const dbSchema = pgSchema(schemaName);
  const schema: Record<string, PgTable> = {};

  for (const [name, mutation] of Object.entries(config.mutations)) {
    const tableName = `${name.toLowerCase()}_mutations`;
    schema[tableName] = dbSchema.table(
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

/** Tables that every deployment has, in the Postgres schema `schemaName`. */
export function createTypewriterSchema(schemaName: string) {
  const dbSchema = pgSchema(schemaName);
  return {
    storageSlots: dbSchema.table(
      "storage_slots",
      {
        execution_index: bigint({ mode: "bigint" }).notNull(),
        slot: bytes32().notNull(),
        value: bytes32().notNull(),
      },
      // TODO(kyle) revisit indexes once db-query is finalized
      (table) => [primaryKey({ columns: [table.slot, table.execution_index] })],
    ),
    keccakPreimages: dbSchema.table("keccak_preimages", {
      preimage: char({ length: 130 }).$type<Hex.Hex>().notNull().primaryKey(),
    }),
    // Never rename this table or `schema_version`: every version reads them
    // to find which migrations to run.
    typewriterMetadata: dbSchema.table("typewriter_metadata", {
      schema_version: integer()
        .notNull()
        .$defaultFn(() => TYPEWRITER_SCHEMA_VERSION),
      address: char({ length: 42 }).$type<Hex.Hex>().notNull(),
      chain_id: bigint({ mode: "number" }).notNull(),
      code_hash: bytes32().notNull(),
    }),
  };
}

export type TypewriterSchema = ReturnType<typeof createTypewriterSchema>;

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
  schema: string;
  columns: BuildColumns<tableName, MutationTableColumns<mutationConfig>, "pg">;
  dialect: "pg";
}>;
