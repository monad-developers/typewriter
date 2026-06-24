import { expect, test } from "bun:test";
import { anvil } from "viem/chains";
import Counter from "../test/contracts/src/Counter.sol";
import { SCHEDULER_ACCOUNT, TEST_DB_URL, TEST_RPC_URL } from "../test/setup";
import { deployCounter } from "../test/utils";
import { createTypewriter, TYPEWRITER_DOMAIN } from "./index";

test("typewriter.domain is fixed", async () => {
  const address = await deployCounter(SCHEDULER_ACCOUNT.address);
  const typewriter = await createTypewriter(Counter, {
    address,
    account: SCHEDULER_ACCOUNT,
    chainId: anvil.id,
    rpcUrl: TEST_RPC_URL,
    database: { url: TEST_DB_URL, maxConnections: 2 },
  });

  try {
    expect(typewriter.domain).toEqual({
      ...TYPEWRITER_DOMAIN,
      chainId: anvil.id,
      verifyingContract: address,
    });
  } finally {
    await typewriter.close();
  }
});
