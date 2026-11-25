import { generateDrizzleJson, generateMigration } from "drizzle-kit/api";
import { sql } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core/table";
import { Data, Effect } from "effect";
import { type Address, Hash, Hex } from "ox";
import type { Db } from "./db";
import { selectMaxExecutionIndex } from "./db-query";
import {
  type createTypewriterSchema,
  TYPEWRITER_SCHEMA_VERSION,
} from "./db-schema";
import { builder, type DbError } from "./db-transport";

type TypewriterSchema = ReturnType<typeof createTypewriterSchema>;

export class MigrationError extends Data.TaggedError("MigrationError")<{
  message: string;
  cause?: unknown;
}> {}

/** The advisory lock that one runtime holds for the deployment's schema. */
export function deploymentLockKey(schemaName: string): bigint {
  return BigInt.asIntN(
    64,
    Hex.toBigInt(Hash.keccak256(Hex.fromString(schemaName))),
  );
}

function createTablesStatements(
  tables: Record<string, PgTable>,
): Effect.Effect<string[], MigrationError> {
  return Effect.tryPromise({
    try: () =>
      generateMigration(generateDrizzleJson({}), generateDrizzleJson(tables)),
    catch: (cause) =>
      new MigrationError({
        message: "Failed to generate Drizzle migration statements",
        cause,
      }),
  });
}

/**
 * Drop a `dev` process's schema when it closes.
 *
 * @dev The caller must hold `db.lock(deploymentLockKey(schemaName))`.
 */
export function dropSchema(
  db: Db,
  schemaName: string,
): Effect.Effect<void, DbError> {
  return db
    .run(
      builder.execute(
        sql`DROP SCHEMA IF EXISTS ${sql.identifier(schemaName)} CASCADE`,
      ),
    )
    .pipe(Effect.asVoid);
}

/** The deployment that a schema's `typewriter_metadata` recorded. */
export type DeploymentMetadata = {
  address: Address.Address;
  chainId: number;
  /** keccak256 of the runtime bytecode at `address`. */
  codeHash: Hex.Hex;
  /** See `creationCodeHash`. */
  creationCodeHash: Hex.Hex;
};

/**
 * The deployment that `schemaName` recorded, or `undefined` if the schema has
 * no `typewriter_metadata`. Fails for a schema of another schema version.
 *
 * @dev The caller must hold `db.lock(deploymentLockKey(schemaName))`.
 */
export function readMetadata(
  db: Db,
  schemaName: string,
  typewriterSchema: TypewriterSchema,
): Effect.Effect<DeploymentMetadata | undefined, MigrationError | DbError> {
  return Effect.gen(function* () {
    const [{ exists }] = (yield* db.run(
      builder.execute<{ exists: boolean }>(
        sql`SELECT to_regclass(quote_ident(${schemaName}) || '.typewriter_metadata') IS NOT NULL AS exists`,
      ),
    )) as unknown as [{ exists: boolean }];
    if (!exists) return undefined;

    const { typewriterMetadata } = typewriterSchema;
    // Every version has `schema_version`, so read it before the other columns.
    const [versionRow] = yield* db.run(
      builder
        .select({ schema_version: typewriterMetadata.schema_version })
        .from(typewriterMetadata),
    );
    if (versionRow === undefined) return undefined;
    const version = versionRow.schema_version;
    if (version !== TYPEWRITER_SCHEMA_VERSION) {
      return yield* new MigrationError({
        message: `Schema ${schemaName} has schema_version=${version}, but this Typewriter reads only schema_version=${TYPEWRITER_SCHEMA_VERSION}; use a new config.deployment`,
      });
    }
    const [row] = yield* db.run(builder.select().from(typewriterMetadata));
    return {
      address: row!.address,
      chainId: row!.chain_id,
      codeHash: row!.code_hash,
      creationCodeHash: row!.creation_code_hash,
    };
  });
}

/**
 * Create the deployment schema, or migrate and check an existing one.
 *
 * @dev The caller must hold `db.lock(deploymentLockKey(...))`.
 * @param schemaName - The Postgres schema that both table groups were built with.
 * @param deployment - The deployment, with the keccak256 of its runtime
 * bytecode and the `creationCodeHash` of its compiled creation bytecode.
 * @param chainExecutionIndex - `executionIndex()` of the contract at the
 * startup block, read after the lock is held.
 */
export function migrate(
  db: Db,
  schemaName: string,
  typewriterSchema: TypewriterSchema,
  mutationSchema: Record<string, PgTable>,
  deployment: {
    chainId: number;
    address: Address.Address;
    codeHash: Hex.Hex;
    creationCodeHash: Hex.Hex;
  },
  executionIndex: bigint,
): Effect.Effect<void, MigrationError | DbError> {
  return Effect.gen(function* () {
    const { typewriterMetadata: _, ...rest } = typewriterSchema;
    const createStatements = yield* createTablesStatements({
      ...rest,
      ...mutationSchema,
    });
    const metadata = {
      address: deployment.address.toLowerCase() as Hex.Hex,
      chain_id: deployment.chainId,
      code_hash: deployment.codeHash.toLowerCase() as Hex.Hex,
      creation_code_hash: deployment.creationCodeHash.toLowerCase() as Hex.Hex,
    };

    const { typewriterMetadata } = typewriterSchema;
    const [, , [row]] = yield* db.run([
      builder.execute(
        sql`CREATE SCHEMA IF NOT EXISTS ${sql.identifier(schemaName)}`,
      ),
      builder.execute(sql`
CREATE TABLE IF NOT EXISTS ${sql.identifier(schemaName)}.typewriter_metadata (
  schema_version integer NOT NULL,
  address char(42) NOT NULL,
  chain_id bigint NOT NULL,
  code_hash char(66) NOT NULL,
  creation_code_hash char(66) NOT NULL
)
  `),
      builder
        .select({ schema_version: typewriterMetadata.schema_version })
        .from(typewriterMetadata),
    ]);
    const version = row?.schema_version;

    if (version !== undefined && version > TYPEWRITER_SCHEMA_VERSION) {
      return yield* new MigrationError({
        message: `Schema ${schemaName} has schema_version=${version}, which is newer than this Typewriter (${TYPEWRITER_SCHEMA_VERSION})`,
      });
    }
    // `resolveDeployment` read the recorded deployment under the same lock,
    // checked it against the config and the compiled contract, and resolved
    // `deployment` from it.

    // TODO(kyle) check that execution indexes start at 0 and have no gaps.
    // A new schema has no mutation tables yet, so nothing has executed.
    const [{ max = null } = {}] =
      version === undefined
        ? []
        : yield* db.run(selectMaxExecutionIndex(mutationSchema));
    const nextExecutionIndex = max === null ? 0n : max + 1n;

    // TODO(kyle) check the length of the force-inclusion queue in storage
    // against the queue onchain at the startup block, as well as the
    // execution index. A missing or extra entry shifts every later
    // enqueued mutation, so `execute` runs a different queued mutation
    // onchain than the one revm accepted.
    if (nextExecutionIndex < executionIndex) {
      // TODO(kyle) catch up from calldata and `ForceInclusionQueued` logs
      // instead of failing.
      return yield* new MigrationError({
        message: `Schema ${schemaName} is behind the chain: next=${nextExecutionIndex} onchain=${executionIndex}`,
      });
    }

    // TODO(kyle) UNDECIDED, decide with the simulation tests:
    // - Rows with an index at or above `chainExecutionIndex` are not
    //   onchain at the startup block: send them again, or drop them.
    // - Rows below it are onchain at the startup block, but not final.
    // - Whether the runtime replays all unfinalized rows from finalized
    //   storage, so a reorg uses the same path.
    // - How far back to scan `ForceInclusionQueued` logs (a stored
    //   checkpoint, or a contract getter for the queue).

    if (version === undefined) {
      yield* db.run([
        ...createStatements.map((statement) => builder.execute(statement)),
        builder.insert(typewriterMetadata).values(metadata),
      ]);
    }
  });
}
