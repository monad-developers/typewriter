import { expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { pgTable, serial, text } from "drizzle-orm/pg-core";
import { Effect } from "effect";
import { TEST_DB_URL } from "../test/setup";
import { Database, layerDatabaseLive } from "./db";

const usersTable = pgTable("effect_db_users", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
});

test("Database service runs Effect-native Drizzle queries", async () => {
  const program = Effect.gen(function* () {
    const db = yield* Database;

    yield* db.execute(sql`
      CREATE TABLE effect_db_users (
        id serial PRIMARY KEY,
        name text NOT NULL
      )
    `);
    yield* db.insert(usersTable).values({ name: "Ada" });

    const users = yield* db.select().from(usersTable);

    expect(users).toEqual([{ id: 1, name: "Ada" }]);
  });

  await Effect.runPromise(
    program.pipe(
      Effect.provide(
        layerDatabaseLive({ url: TEST_DB_URL, maxConnections: 1 }),
      ),
    ),
  );
});

test("Database service runs Effect-native transactions", async () => {
  const program = Effect.gen(function* () {
    const db = yield* Database;

    yield* db.execute(sql`
      CREATE TABLE effect_db_users (
        id serial PRIMARY KEY,
        name text NOT NULL
      )
    `);

    const users = yield* db.transaction((tx) =>
      Effect.gen(function* () {
        yield* tx.insert(usersTable).values({ name: "Grace" });
        yield* tx.insert(usersTable).values({ name: "Katherine" });

        return yield* tx.select().from(usersTable);
      }),
    );

    expect(users).toEqual([
      { id: 1, name: "Grace" },
      { id: 2, name: "Katherine" },
    ]);
  });

  await Effect.runPromise(
    program.pipe(
      Effect.provide(
        layerDatabaseLive({ url: TEST_DB_URL, maxConnections: 1 }),
      ),
    ),
  );
});
