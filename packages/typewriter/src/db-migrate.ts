import { generateDrizzleJson, generateMigration } from "drizzle-kit/api";
import { sql } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core/table";
import { Data, Effect } from "effect";
import { type Address, Hash, Hex } from "ox";
import { deploymentKey } from "./client";
import type { Db, DbError } from "./db";
import { selectMaxExecutionIndex } from "./db-query";
import {
  type createTypewriterSchema,
  TYPEWRITER_SCHEMA_VERSION,
} from "./db-schema";

type TypewriterSchema = ReturnType<typeof createTypewriterSchema>;

export class MigrationError extends Data.TaggedError("MigrationError")<{
  message: string;
  cause?: unknown;
}> {}

export function deploymentLockKey(
  chainId: number,
  address: Address.Address,
): bigint {
  const name = `typewriter_${deploymentKey(chainId, address)}`;
  return BigInt.asIntN(64, Hex.toBigInt(Hash.keccak256(Hex.fromString(name))));
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
 * Create the deployment schema, or migrate and check an existing one.
 *
 * @dev The caller must hold `db.lock(deploymentLockKey(...))`.
 * @param schemaName - The Postgres schema that both table groups were built with.
 * @param deployment - The deployment, with the keccak256 of its runtime bytecode.
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
    };

    return yield* db.transaction((tx) =>
      Effect.gen(function* () {
        yield* tx.query((db) =>
          db.execute(
            sql`CREATE SCHEMA IF NOT EXISTS ${sql.identifier(schemaName)}`,
          ),
        );

        yield* tx.query((db) =>
          db.execute(sql`
CREATE TABLE IF NOT EXISTS ${sql.identifier(schemaName)}.typewriter_metadata (
  schema_version integer NOT NULL,
  address char(42) NOT NULL,
  chain_id bigint NOT NULL,
  code_hash char(66) NOT NULL
)
  `),
        );
        const [row] = yield* tx.query((db) =>
          db
            .select({
              schema_version:
                typewriterSchema.typewriterMetadata.schema_version,
            })
            .from(typewriterSchema.typewriterMetadata),
        );
        const version = row?.schema_version;

        if (version === undefined) {
          for (const statement of createStatements) {
            yield* tx.query((db) => db.execute(statement));
          }
          yield* tx.query((db) =>
            db.insert(typewriterSchema.typewriterMetadata).values(metadata),
          );
        } else if (version > TYPEWRITER_SCHEMA_VERSION) {
          return yield* new MigrationError({
            message: `Schema ${schemaName} has schema_version=${version}, which is newer than this Typewriter (${TYPEWRITER_SCHEMA_VERSION})`,
          });
        } else {
          // Note: There's currently only one schema version, no migration is possible.
          // TODO(kyle) check metadata matches expected values
        }

        // TODO(kyle) check that execution indexes start at 0 and have no gaps.
        const max = yield* selectMaxExecutionIndex(tx, mutationSchema);
        const nextExecutionIndex = max === undefined ? 0n : max + 1n;

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
      }),
    );
  });
}
