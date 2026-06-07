import { expect, test } from "bun:test";
import { SCHEDULER_ACCOUNT, TEST_DB_URL, TEST_RPC_URL } from "../test/setup";
import { COUNTER_SIGNATURE_PARAMS, EMPTY_STORAGE_LAYOUT } from "../test/utils";
import { createFFCA } from "./index";

test("ffca.domain is derived from config", async () => {
  const ffca = await createFFCA<
    typeof EMPTY_STORAGE_LAYOUT,
    Record<string, never>,
    typeof COUNTER_SIGNATURE_PARAMS
  >({
    address: "0x000000000000000000000000000000000000abcd",
    signature: { params: COUNTER_SIGNATURE_PARAMS },
    storageLayout: EMPTY_STORAGE_LAYOUT,
    account: SCHEDULER_ACCOUNT,
    chainId: 1,
    rpcUrl: TEST_RPC_URL,
    database: { url: TEST_DB_URL, maxConnections: 2 },
    domain: { name: "my-app", version: "2" },
    mutations: {},
  });

  expect(ffca.domain).toMatchInlineSnapshot(`
    {
      "chainId": 1,
      "name": "my-app",
      "verifyingContract": "0x000000000000000000000000000000000000abcd",
      "version": "2",
    }
  `);
});
