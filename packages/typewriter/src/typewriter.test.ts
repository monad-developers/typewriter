import { expect, test } from "bun:test";
import { anvil } from "viem/chains";
import Counter from "../test/contracts/src/Counter.sol";
import { SCHEDULER_ACCOUNT, TEST_DB_URL, TEST_RPC_URL } from "../test/setup";
import { deployCounter } from "../test/utils";
import { createTypewriter } from "./index";

test("typewriter exposes the native-account manifest", async () => {
  const address = await deployCounter();
  const typewriter = await createTypewriter(Counter, {
    address,
    account: SCHEDULER_ACCOUNT,
    chainId: anvil.id,
    rpcUrl: TEST_RPC_URL,
    database: { url: TEST_DB_URL, maxConnections: 2 },
  });

  try {
    expect({
      address: typewriter.manifest.address,
      chainId: typewriter.manifest.chainId,
      mutationIDs: Object.fromEntries(
        Object.entries(typewriter.manifest.mutations).map(
          ([name, mutation]) => [name, (mutation as { id: number }).id],
        ),
      ),
    }).toEqual({
      address,
      chainId: anvil.id,
      mutationIDs: {
        Add: 0,
        CreateAccount: 253,
        AddCredential: 254,
        RemoveCredential: 255,
      },
    });
  } finally {
    await typewriter.close();
  }
});
