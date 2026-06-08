import { expect, test } from "bun:test";
import { anvil } from "viem/chains";
import { SCHEDULER_ACCOUNT, TEST_DB_URL, TEST_RPC_URL } from "../test/setup";
import {
  COUNTER_SIGNATURE_PARAMS,
  deployCounter,
  EMPTY_STORAGE_LAYOUT,
} from "../test/utils";
import { createFFCA } from "./index";

test("ffca.domain is derived from config", async () => {
  const address = await deployCounter(SCHEDULER_ACCOUNT.address);
  const ffca = await createFFCA<
    typeof EMPTY_STORAGE_LAYOUT,
    Record<string, never>,
    typeof COUNTER_SIGNATURE_PARAMS
  >({
    address,
    signature: { params: COUNTER_SIGNATURE_PARAMS },
    storageLayout: EMPTY_STORAGE_LAYOUT,
    account: SCHEDULER_ACCOUNT,
    chainId: anvil.id,
    rpcUrl: TEST_RPC_URL,
    database: { url: TEST_DB_URL, maxConnections: 2 },
    domain: { name: "my-app", version: "2" },
    mutations: {},
  });

  try {
    expect(ffca.domain).toEqual({
      chainId: anvil.id,
      name: "my-app",
      verifyingContract: address,
      version: "2",
    });
  } finally {
    await ffca.close();
  }
});
