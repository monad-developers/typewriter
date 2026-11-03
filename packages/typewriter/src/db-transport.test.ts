import { describe, expect, test } from "bun:test";
import { jsonb } from "abipg";
import { sql } from "drizzle-orm";
import { bigint, numeric, pgSchema } from "drizzle-orm/pg-core";
import { Effect } from "effect";
import { makeDb } from "./db";
import { builder, DbError } from "./db-transport";

// biome-ignore lint/complexity/useLiteralKeys: `process.env` has an index signature.
const DATABASE_URL = process.env["DATABASE_URL"];

let schemas = 0;

function withTable<a, e>(
  f: (
    table: ReturnType<typeof makeTable>,
    db: Effect.Success<ReturnType<typeof makeDb>>,
  ) => Effect.Effect<a, e>,
) {
  return Effect.gen(function* () {
    const db = yield* makeDb({ url: DATABASE_URL!, maxConnections: 1 });
    const schemaName = `typewriter_test_${process.pid}_transport_${schemas++}`;
    const schema = sql.identifier(schemaName);
    yield* Effect.acquireRelease(
      db.run([
        builder.execute(sql`CREATE SCHEMA ${schema}`),
        builder.execute(
          sql`CREATE TABLE ${schema}.rows (id bigint PRIMARY KEY, amount numeric(78, 0) NOT NULL, data jsonb NOT NULL)`,
        ),
      ]),
      () =>
        db
          .run(builder.execute(sql`DROP SCHEMA ${schema} CASCADE`))
          .pipe(Effect.orDie),
    );
    return yield* f(makeTable(schemaName), db);
  }).pipe(Effect.scoped, Effect.runPromise);
}

function makeTable(schemaName: string) {
  return pgSchema(schemaName).table("rows", {
    id: bigint({ mode: "bigint" }).primaryKey(),
    amount: numeric({ precision: 78, scale: 0 }).notNull(),
    data: jsonb().$type<{ values: number[] }>().notNull(),
  });
}

describe.skipIf(DATABASE_URL === undefined)("run", () => {
  test("sends the statements as they were when `run` was called", () =>
    withTable((table, db) =>
      Effect.gen(function* () {
        const row = {
          id: 1n,
          amount: (2n ** 255n).toString(),
          data: { values: [1] },
        };
        const insert = db.run(builder.insert(table).values([row]));
        row.id = 2n;
        row.data.values.push(2);
        yield* insert;
        expect([
          ...(yield* db.run(builder.select().from(table))),
        ]).toStrictEqual([
          { id: 1n, amount: (2n ** 255n).toString(), data: { values: [1] } },
        ]);
        const types = yield* db.run(
          builder.execute<{ type: string }>(
            sql`SELECT jsonb_typeof(${table.data}) AS type FROM ${table}`,
          ),
        );
        expect(types.map(({ type }) => type)).toStrictEqual(["object"]);
      }),
    ));

  test("runs the statements in order and returns their results", () =>
    withTable((table, db) =>
      Effect.gen(function* () {
        const [, selected, updated] = yield* db.run([
          builder.execute(
            sql`INSERT INTO ${table} VALUES (1, 10, '{"values": []}')`,
          ),
          builder
            .select({ id: table.id, amount: table.amount, data: table.data })
            .from(table),
          builder
            .update(table)
            .set({ amount: "30" })
            .where(sql`${table.id} = ${1n}`)
            .returning({ amount: table.amount }),
        ]);
        expect([...selected]).toStrictEqual([
          { id: 1n, amount: "10", data: { values: [] } },
        ]);
        expect([...updated]).toStrictEqual([{ amount: "30" }]);
      }),
    ));

  test("rolls back every statement when one fails", () =>
    withTable((table, db) =>
      Effect.gen(function* () {
        const failing = builder.execute(
          sql.raw(
            "DO $$ BEGIN RAISE EXCEPTION 'test' USING ERRCODE = 'serialization_failure'; END $$",
          ),
        );
        const error = yield* db
          .run([
            builder
              .insert(table)
              .values([{ id: 1n, amount: "1", data: { values: [] } }]),
            failing,
          ])
          .pipe(Effect.flip);
        expect(error).toBeInstanceOf(DbError);
        expect(error.notApplied).toBe(true);
        expect(error.sql).toStartWith("DO $$");
        expect(yield* db.run(builder.select().from(table))).toStrictEqual([]);
      }),
    ));
});
