import { describe, expect, test } from "bun:test";
import { asc } from "drizzle-orm";
import { Effect } from "effect";
import { makeDb } from "./db";
import { dropSchema, migrate } from "./db-migrate";
import { insertMutations } from "./db-query";
import { createMutationSchema, createTypewriterSchema } from "./db-schema";
import { builder } from "./db-transport";
import type { AcceptedMutation, Authorization } from "./typewriter-types";

// biome-ignore lint/complexity/useLiteralKeys: `process.env` has an index signature.
const DATABASE_URL = process.env["DATABASE_URL"];

const MEMO = {
  id: 0,
  params: [
    { name: "memo", type: "string" },
    { name: "memos", type: "string[]" },
  ],
} as const;

const AUTHORIZATION = {
  accountID:
    "0x1111111111111111111111111111111111111111111111111111111111111111",
  credentialID: 7n,
  nonce: 11n,
  expiration: 1_900_000_000n,
  signature: "0xdeadbeef",
} as const satisfies Authorization;

let schemas = 0;

/**
 * Inserts a mutation row for each string, in a `text` column and in a `jsonb`
 * array, as the runtime does, and reads the rows back.
 */
function roundTrip(strings: readonly string[]) {
  return Effect.gen(function* () {
    const db = yield* makeDb({ url: DATABASE_URL!, maxConnections: 1 });
    const schemaName = `typewriter_test_${process.pid}_${schemas++}`;
    const mutationSchema = createMutationSchema(schemaName, {
      mutations: { Memo: MEMO },
    });
    yield* Effect.acquireRelease(
      migrate(
        db,
        schemaName,
        createTypewriterSchema(schemaName),
        mutationSchema,
        {
          chainId: 1,
          address: "0x0000000000000000000000000000000000000001",
          codeHash: `0x${"00".repeat(32)}`,
        },
        0n,
      ),
      () => dropSchema(db, schemaName).pipe(Effect.orDie),
    );
    yield* db.run(
      insertMutations(
        mutationSchema,
        strings.map(
          (memo, index): AcceptedMutation => ({
            status: "accepted",
            name: "Memo",
            params: { memo, memos: [memo] },
            authorization: AUTHORIZATION,
            executionIndex: BigInt(index),
            config: MEMO,
          }),
        ),
      ),
    );
    const table = mutationSchema.memo_mutations;
    const rows = yield* db.run(
      builder.select().from(table).orderBy(asc(table.execution_index)),
    );
    return rows.map(({ memo, memos }) => ({ memo, memos }));
  }).pipe(Effect.scoped, Effect.runPromise);
}

const rowsOf = (strings: readonly string[]) =>
  strings.map((memo) => ({ memo, memos: [memo] }));

describe.skipIf(DATABASE_URL === undefined)("mutation rows", () => {
  test("hold the strings they were executed with", async () => {
    const strings = [
      "",
      "a",
      "héllo wörld",
      "日本語",
      "🙂🙂",
      "x".repeat(100),
      // A BOM, which a UTF-8 decoder strips by default.
      "﻿bom",
      // Text that `COPY` or a driver could read as an escape.
      "\\",
      "\\\\",
      "\\b",
      "\\f",
      "\\n",
      "\\r",
      "\\t",
      "\\v",
      "\\00",
      "\\x00",
      "\\N",
      "\b",
      "\f",
      "\n",
      "\r",
      "\t",
      "\v",
      "\u0001",
      "\u007f",
      " ",
      "'",
      "''",
      '"',
      "$1",
    ];
    expect(await roundTrip(strings)).toStrictEqual(rowsOf(strings));
  });

  test("hold lone surrogates as U+FFFD, as the contract decodes them", async () => {
    expect(await roundTrip(["\uD800", "a\uDC00b"])).toStrictEqual(
      rowsOf(["�", "a�b"]),
    );
  });

  // Postgres `text` and `jsonb` cannot hold NUL, so the row holds U+FFFD.
  test.failing("hold strings with NUL", async () => {
    const strings = ["\u0000", "a\u0000b"];
    expect(await roundTrip(strings)).toStrictEqual(rowsOf(strings));
  });
});
