import { expect, test } from "bun:test";
import { TEST_DB_CONNECTION, TEST_PUBLIC_CLIENT } from "./setup";

test("setup smoke: anvil is reachable", async () => {
  await expect(TEST_PUBLIC_CLIENT.getChainId()).resolves.toBe(31337);
  await expect(
    TEST_PUBLIC_CLIENT.getBlockNumber(),
  ).resolves.toBeGreaterThanOrEqual(0n);
});

test("setup smoke: postgres test database is isolated", async () => {
  const rows = await TEST_DB_CONNECTION<{ database: string; ok: number }[]>`
    SELECT current_database() AS database, 1::int AS ok
  `;

  expect(rows).toEqual([
    {
      database: expect.stringMatching(/^ffca_test_/),
      ok: 1,
    },
  ]);
});
