import { expect, test } from "bun:test";
import { anvil } from "viem/chains";
import Counter from "../test/contracts/src/Counter.sol";
import { SCHEDULER_ACCOUNT, TEST_DB_URL, TEST_RPC_URL } from "../test/setup";
import { deployCounter } from "../test/utils";
import { createFFCA } from "./index";

test("ffca.domain is derived from config", async () => {
  const address = await deployCounter(SCHEDULER_ACCOUNT.address);
  const ffca = await createFFCA(Counter, {
    address,
    account: SCHEDULER_ACCOUNT,
    chainId: anvil.id,
    rpcUrl: TEST_RPC_URL,
    database: { url: TEST_DB_URL, maxConnections: 2 },
    domain: { name: "my-app", version: "2" },
    mutations: { newAccount: {}, add: {} },
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
