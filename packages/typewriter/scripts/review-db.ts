// Run from the repository root: bun run packages/typewriter/scripts/review-db.ts
// Needs local PostgreSQL binaries (override PG_BIN if necessary). No shared DB is used.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SQL } from "bun";
import { sql } from "drizzle-orm";
import { integer, jsonb, pgTable } from "drizzle-orm/pg-core";
import { Context, Effect, Exit } from "effect";
import { type Db, DbError, makeDb } from "../src/db";

const pgBin =
  (process.env as { PG_BIN?: string }).PG_BIN ?? "/usr/lib/postgresql/16/bin";
const directory = await mkdtemp(join(tmpdir(), "typewriter-db-review-"));
const data = join(directory, "data");
const listener = Bun.listen({
  hostname: "127.0.0.1",
  port: 0,
  socket: { data() {} },
});
const port = listener.port;
listener.stop(true);
const url = `postgresql://ubuntu@127.0.0.1:${port}/postgres`;
let started = false;
let failures = 0;
let passes = 0;

async function command(name: string, args: string[]) {
  const proc = Bun.spawn([join(pgBin, name), ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  assert.equal(code, 0, `${name}: ${stdout}\n${stderr}`);
}

async function test(name: string, run: () => Promise<unknown>) {
  try {
    await run();
    passes++;
    console.log(`PASS ${name}`);
  } catch (error) {
    failures++;
    console.error(`FAIL ${name}`, error);
  }
}

function withDb<A, E>(
  f: (db: Db) => Effect.Effect<A, E>,
  statementTimeoutMs = 1_000,
) {
  return Effect.runPromise(
    Effect.scoped(
      Effect.flatMap(
        makeDb({
          url,
          maxConnections: 1,
          statementTimeoutMs,
          idleInTransactionTimeoutMs: 1_000,
        }),
        f,
      ),
    ),
  );
}

function failed<A, E>(exit: Exit.Exit<A, E>): E {
  const result = Exit.findError(exit);
  assert.equal(
    result._tag,
    "Success",
    `Expected typed failure: ${String(exit)}`,
  );
  if (result._tag !== "Success") throw new Error("Expected typed failure");
  return result.success;
}

try {
  await command("initdb", [
    "-D",
    data,
    "-A",
    "trust",
    "-U",
    "ubuntu",
    "--no-locale",
  ]);
  await command("pg_ctl", [
    "-D",
    data,
    "-l",
    join(directory, "postgres.log"),
    "-o",
    `-h 127.0.0.1 -p ${port} -k ${directory}`,
    "-w",
    "start",
  ]);
  started = true;
  const admin = new SQL({ url, max: 2, prepare: false });
  try {
    await admin`create table items (id integer primary key, value jsonb)`;
    await admin`create table deferred_items (id integer unique deferrable initially deferred)`;

    await test("Drizzle JSONB insert stores an object rather than a JSON string", async () => {
      const items = pgTable("items", {
        id: integer("id"),
        value: jsonb("value"),
      });
      await withDb((db) =>
        db.query((d) =>
          d.insert(items).values({ id: 20, value: { nested: [1, true] } }),
        ),
      );
      const [row] =
        await admin`select value, jsonb_typeof(value) as kind from items where id = 20`;
      assert.equal(row.kind, "object");
      assert.deepEqual(row.value, { nested: [1, true] });
    });

    await test("queries are lazy and support parameters and JSONB", async () => {
      await withDb((db) =>
        Effect.gen(function* () {
          let builds = 0;
          const query = db.query((client) => {
            builds++;
            return client.execute(
              sql`select ${42}::integer as answer, ${JSON.stringify({ a: [1, true] })}::jsonb as value`,
            );
          });
          assert.equal(builds, 0);
          const rows = yield* query;
          assert.equal(builds, 1);
          assert.deepEqual(rows[0], { answer: 42, value: { a: [1, true] } });
        }),
      );
    });

    await test("transaction commits and returns its value", async () => {
      const value = await withDb((db) =>
        db.transaction((tx) =>
          Effect.gen(function* () {
            yield* tx.query((d) =>
              d.execute(sql`insert into items values (1, '{"ok":true}')`),
            );
            return "committed";
          }),
        ),
      );
      assert.equal(value, "committed");
      assert.equal(
        (await admin`select count(*)::int as n from items where id = 1`)[0].n,
        1,
      );
    });

    await test("typed body failure rolls back and preserves the error", async () => {
      const error = { reason: "stop" };
      const exit = await withDb((db) =>
        Effect.exit(
          db.transaction((tx) =>
            Effect.gen(function* () {
              yield* tx.query((d) =>
                d.execute(sql`insert into items values (2, null)`),
              );
              return yield* Effect.fail(error);
            }),
          ),
        ),
      );
      assert.equal(failed(exit), error);
      assert.equal(
        (await admin`select count(*)::int as n from items where id = 2`)[0].n,
        0,
      );
    });

    await test("recovered SQL failure still rolls back the transaction", async () => {
      const exit = await withDb((db) =>
        Effect.exit(
          db.transaction((tx) =>
            Effect.gen(function* () {
              yield* tx.query((d) =>
                d.execute(sql`insert into items values (3, null)`),
              );
              yield* tx
                .query((d) => d.execute(sql`select 1 / 0`))
                .pipe(Effect.catch(() => Effect.void));
            }),
          ),
        ),
      );
      assert.ok(failed(exit) instanceof DbError);
      assert.equal(
        (await admin`select count(*)::int as n from items where id = 3`)[0].n,
        0,
      );
    });

    await test("permanent query error includes SQL and is not retried", async () => {
      let builds = 0;
      const exit = await withDb((db) =>
        Effect.exit(
          db.query((d) => {
            builds++;
            return d.execute(sql`select 1 / 0`);
          }),
        ),
      );
      const error = failed(exit);
      assert.ok(error instanceof DbError);
      assert.equal(error.sql, "select 1 / 0");
      assert.equal(error.notApplied, false);
      assert.equal(builds, 1);
    });

    for (const code of ["40001", "40P01"]) {
      await test(`${code} retries the whole transaction, with a limit of five attempts`, async () => {
        let attempts = 0;
        const exit = await withDb((db) =>
          Effect.exit(
            db.transaction((tx) =>
              Effect.gen(function* () {
                attempts++;
                yield* tx.query((d) =>
                  d.execute(sql`insert into items values (4, null)`),
                );
                yield* tx.query((d) =>
                  d.execute(
                    sql.raw(
                      `do $$ begin raise exception 'injected retry' using errcode = '${code}'; end $$`,
                    ),
                  ),
                );
              }),
            ),
          ),
        );
        assert.ok(failed(exit) instanceof DbError);
        assert.equal(attempts, 5);
        assert.equal(
          (await admin`select count(*)::int as n from items where id = 4`)[0].n,
          0,
        );
      });
    }

    await test("transaction keeps Effect context", async () => {
      class Value extends Context.Service<Value, number>()("review/Value") {}
      const value = await withDb((db) =>
        db
          .transaction(() => Effect.map(Value, (v) => v + 1))
          .pipe(Effect.provideService(Value, 41)),
      );
      assert.equal(value, 42);
    });

    await test("a transient failure retries successfully and commits exactly once", async () => {
      let attempts = 0;
      const result = await withDb((db) =>
        db.transaction((tx) =>
          Effect.gen(function* () {
            attempts++;
            yield* tx.query((d) =>
              d.execute(sql`insert into items values (8, null)`),
            );
            if (attempts === 1)
              yield* tx.query((d) =>
                d.execute(
                  sql`do $$ begin raise exception 'retry once' using errcode = '40001'; end $$`,
                ),
              );
            return "done";
          }),
        ),
      );
      assert.equal(result, "done");
      assert.equal(attempts, 2);
      assert.equal(
        (await admin`select count(*)::int as n from items where id = 8`)[0].n,
        1,
      );
    });

    await test("statement timeout fails and rolls back", async () => {
      const exit = await withDb(
        (db) =>
          Effect.exit(
            db.transaction((tx) =>
              Effect.gen(function* () {
                yield* tx.query((d) =>
                  d.execute(sql`insert into items values (5, null)`),
                );
                yield* tx.query((d) => d.execute(sql`select pg_sleep(1)`));
              }),
            ),
          ),
        50,
      );
      assert.ok(failed(exit) instanceof DbError);
      assert.equal(
        (await admin`select count(*)::int as n from items where id = 5`)[0].n,
        0,
      );
    });

    await test("lost connection retries on a new session without duplicate writes", async () => {
      let attempts = 0;
      await withDb((db) =>
        db.transaction((tx) =>
          Effect.gen(function* () {
            attempts++;
            yield* tx.query((d) =>
              d.execute(sql`insert into items values (6, null)`),
            );
            if (attempts === 1) {
              const rows = yield* tx.query((d) =>
                d.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`),
              );
              const { pid } = rows[0] as { pid: number };
              yield* Effect.promise(
                () => admin`select pg_terminate_backend(${pid})`,
              );
              yield* tx.query((d) => d.execute(sql`select 1`));
            }
          }),
        ),
      );
      assert.equal(attempts, 2);
      assert.equal(
        (await admin`select count(*)::int as n from items where id = 6`)[0].n,
        1,
      );
    });

    await test("interruption rolls back a running transaction", async () => {
      await withDb((db) =>
        Effect.gen(function* () {
          const controller = new AbortController();
          let entered!: () => void;
          const ready = new Promise<void>((resolve) => {
            entered = resolve;
          });
          const running = Effect.runPromiseExit(
            db.transaction((tx) =>
              Effect.gen(function* () {
                yield* tx.query((d) =>
                  d.execute(sql`insert into items values (7, null)`),
                );
                entered();
                yield* Effect.never;
              }),
            ),
            { signal: controller.signal },
          );
          yield* Effect.promise(() => ready);
          controller.abort();
          const exit = yield* Effect.promise(() => running);
          assert.ok(Exit.isFailure(exit));
          yield* db.query((d) => d.execute(sql`select 1`));
        }),
      );
      assert.equal(
        (await admin`select count(*)::int as n from items where id = 7`)[0].n,
        0,
      );
    });

    // Regression probes: keep failures visible; do not encode current bugs as expectations.
    await test("synchronous transaction callback defect is preserved without retries", async () => {
      const defect = new Error("callback defect");
      let attempts = 0;
      const exit = await withDb((db) =>
        Effect.exit(
          db.transaction(() => {
            attempts++;
            throw defect;
          }),
        ),
      );
      assert.equal(attempts, 1);
      assert.ok(Exit.hasDies(exit));
    });

    await test("permanent deferred constraint failure is not retried", async () => {
      let attempts = 0;
      const exit = await withDb((db) =>
        Effect.exit(
          db.transaction((tx) =>
            Effect.gen(function* () {
              attempts++;
              yield* tx.query((d) =>
                d.execute(sql`insert into deferred_items values (1), (1)`),
              );
            }),
          ),
        ),
      );
      assert.ok(failed(exit) instanceof DbError);
      assert.equal(
        (await admin`select count(*)::int as n from deferred_items`)[0].n,
        0,
      );
      assert.equal(attempts, 1);
    });
  } finally {
    await admin.close();
  }
} finally {
  if (started)
    await command("pg_ctl", ["-D", data, "-m", "immediate", "-w", "stop"]);
  await rm(directory, { recursive: true, force: true });
}
console.log(`\n${passes} passed; ${failures} failed`);
process.exitCode = failures === 0 ? 0 : 1;
