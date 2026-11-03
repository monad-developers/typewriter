import { describe, expect, test } from "bun:test";
import { jsonb } from "abipg";
import { sql } from "drizzle-orm";
import { bigint, numeric, pgSchema } from "drizzle-orm/pg-core";
import { Effect, type Scope } from "effect";
import { makeDb } from "./db";
import {
  builder,
  compile,
  DbError,
  makePostgresTransport,
} from "./db-transport";

// biome-ignore lint/complexity/useLiteralKeys: `process.env` has an index signature.
const DATABASE_URL = process.env["DATABASE_URL"];

let schemas = 0;

function withTable<a, e>(
  f: (
    table: ReturnType<typeof makeTable>,
    db: Effect.Success<ReturnType<typeof makeDb>>,
  ) => Effect.Effect<a, e, Scope.Scope>,
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

type Fault =
  /** Closes the connection instead of sending the message. */
  | "cut"
  /** Sends the message, then closes the connection instead of answering. */
  | "dropReply"
  /** Sends the message, then holds every answer until `release`. */
  | "stallReply";

/**
 * A TCP proxy to Postgres that injects `fault` once, when the client sends a
 * message that contains `when`.
 */
function makeProxy() {
  const url = new URL(DATABASE_URL!);
  const upstreamHost = {
    hostname: url.hostname,
    port: Number(url.port || 5432),
  };
  let armed: { when: string; fault: Fault } | undefined;
  const held: (() => void)[] = [];
  const server = Bun.listen<{
    upstream?: Bun.Socket;
    pending: Uint8Array[];
    fault?: Fault;
  }>({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      open(client) {
        client.data = { pending: [] };
        Bun.connect({
          ...upstreamHost,
          socket: {
            open(upstream) {
              client.data.upstream = upstream;
              for (const chunk of client.data.pending) upstream.write(chunk);
            },
            data(upstream, chunk) {
              const copy = new Uint8Array(chunk);
              if (client.data.fault === "dropReply") {
                upstream.end();
                client.end();
              } else if (client.data.fault === "stallReply") {
                held.push(() => {
                  client.data.fault = undefined;
                  client.write(copy);
                });
              } else {
                client.write(copy);
              }
            },
            close() {
              client.end();
            },
          },
        });
      },
      data(client, chunk) {
        const copy = new Uint8Array(chunk);
        if (
          armed !== undefined &&
          Buffer.from(copy).toString("latin1").includes(armed.when)
        ) {
          client.data.fault = armed.fault;
          armed = undefined;
          if (client.data.fault === "cut") {
            client.data.upstream?.end();
            client.end();
            return;
          }
        }
        if (client.data.upstream === undefined) client.data.pending.push(copy);
        else client.data.upstream.write(copy);
      },
      close(client) {
        client.data.upstream?.end();
      },
    },
  });
  url.hostname = "127.0.0.1";
  url.port = String(server.port);
  return {
    url: url.toString(),
    inject: (when: string, fault: Fault) => {
      armed = { when, fault };
    },
    release: () => {
      for (const write of held.splice(0)) write();
    },
    stop: () => server.stop(true),
  };
}

describe.skipIf(DATABASE_URL === undefined)("a dropped connection", () => {
  const timeoutMs = 500;

  function withProxy<a, e>(
    f: (context: {
      proxy: ReturnType<typeof makeProxy>;
      transport: Effect.Success<ReturnType<typeof makePostgresTransport>>;
      insert: ReturnType<typeof compile>;
      count: Effect.Effect<number, DbError>;
    }) => Effect.Effect<a, e, Scope.Scope>,
  ) {
    return withTable((table, db) =>
      Effect.gen(function* () {
        const proxy = yield* Effect.acquireRelease(
          Effect.sync(makeProxy),
          (proxy) => Effect.sync(proxy.stop),
        );
        const transport = yield* makePostgresTransport({
          url: proxy.url,
          maxConnections: 1,
          statementTimeoutMs: timeoutMs,
        });
        // Connects, so the fault hits the run under test.
        yield* transport.run([compile(builder.execute(sql`SELECT 1`))]);
        const count = db
          .run(builder.select({ id: table.id }).from(table))
          .pipe(Effect.map((rows) => rows.length));
        const insert = compile(
          builder
            .insert(table)
            .values([{ id: 1n, amount: "1", data: { values: [] } }]),
        );
        return yield* f({ proxy, transport, insert, count });
      }),
    );
  }

  test("before COMMIT fails as not applied", () =>
    withProxy(({ proxy, transport, insert, count }) =>
      Effect.gen(function* () {
        proxy.inject("insert into", "cut");
        const error = yield* transport.run([insert]).pipe(Effect.flip);
        expect(error.notApplied).toBe(true);
        expect(yield* count).toBe(0);
      }),
    ));

  test("after COMMIT fails as commit unknown", () =>
    withProxy(({ proxy, transport, insert, count }) =>
      Effect.gen(function* () {
        proxy.inject("COMMIT", "dropReply");
        const error = yield* transport.run([insert]).pipe(Effect.flip);
        expect(error.commitUnknown).toBe(true);
        expect(error.notApplied).toBeUndefined();
        expect(yield* count).toBe(1);
      }),
    ));

  test("that stops answering before COMMIT fails by the deadline and never commits", () =>
    withProxy(({ proxy, transport, insert, count }) =>
      Effect.gen(function* () {
        proxy.inject("insert into", "stallReply");
        const startedAt = Date.now();
        const error = yield* transport.run([insert]).pipe(Effect.flip);
        expect(Date.now() - startedAt).toBeLessThan(timeoutMs * 2);
        expect(error.notApplied).toBe(true);
        proxy.release();
        // The pool's only connection, free once the late attempt rolls back.
        yield* transport.run([compile(builder.execute(sql`SELECT 1`))]);
        expect(yield* count).toBe(0);
      }),
    ));

  test("that stops answering COMMIT fails by the deadline as commit unknown", () =>
    withProxy(({ proxy, transport, insert, count }) =>
      Effect.gen(function* () {
        proxy.inject("COMMIT", "stallReply");
        const error = yield* transport.run([insert]).pipe(Effect.flip);
        expect(error.commitUnknown).toBe(true);
        proxy.release();
        expect(yield* count).toBe(1);
      }),
    ));
});
