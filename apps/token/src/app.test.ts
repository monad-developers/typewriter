import { expect, test } from "bun:test";
import { createFFCA, type FFCAConfig } from "ffca";
import type { Abi, Address } from "viem";
import { anvil } from "viem/chains";
import {
  deployToken,
  RECIPIENT_ACCOUNT,
  SCHEDULER_ACCOUNT,
  TEST_DB_URL,
  TEST_PUBLIC_CLIENT,
  TEST_RPC_URL,
  USER_ACCOUNT,
} from "../test/setup";
import { signMint, signTransfer, TOKEN_DOMAIN, tokenMutations } from "./app";
import { TOKEN_STORAGE_LAYOUT } from "./storage-layout";

async function readAccount(params: {
  abi: Abi;
  token: Address;
  account: Address;
}): Promise<{ nonce: bigint; balance: bigint }> {
  const [nonce, balance] = (await TEST_PUBLIC_CLIENT.readContract({
    abi: params.abi,
    address: params.token,
    functionName: "accounts",
    args: [params.account],
  })) as [bigint, bigint];
  return { nonce, balance };
}

test("smoke: FIFO token mint and transfer settle onchain", async () => {
  const { address, abi } = await deployToken();
  const config = {
    address,
    abi: abi as Abi,
    storageLayout: TOKEN_STORAGE_LAYOUT,
    account: SCHEDULER_ACCOUNT,
    chainId: anvil.id,
    rpcUrl: TEST_RPC_URL,
    database: { url: TEST_DB_URL, maxConnections: 4 },
    domain: TOKEN_DOMAIN,
    sequencing: { order: "fifo", submitIntervalMs: 1_000 },
    mutations: tokenMutations,
  } as const satisfies FFCAConfig;
  const ffca = await createFFCA(config);

  const acceptedMutationIds: number[] = [];
  ffca.on("mutation", (event) => {
    if (event.status === "accepted") acceptedMutationIds.push(event.id);
  });

  const deadline = BigInt(Math.floor(Date.now() / 1000) + 60);
  const mint = {
    to: USER_ACCOUNT.address,
    amount: 100n,
    nonce: 0n,
    deadline,
  };
  await ffca.execute({
    name: "Mint",
    args: mint,
    signature: await signMint({
      account: USER_ACCOUNT,
      token: address,
      chainId: anvil.id,
      mint,
    }),
  });

  const transfer = {
    from: USER_ACCOUNT.address,
    to: RECIPIENT_ACCOUNT.address,
    amount: 40n,
    nonce: 1n,
    deadline,
  };
  await ffca.execute({
    name: "Transfer",
    args: transfer,
    signature: await signTransfer({
      account: USER_ACCOUNT,
      token: address,
      chainId: anvil.id,
      transfer,
    }),
  });

  expect(acceptedMutationIds).toHaveLength(2);

  const userState = ffca.state.accounts[USER_ACCOUNT.address];
  const recipientState = ffca.state.accounts[RECIPIENT_ACCOUNT.address];
  expect(await ffca.state.totalSupply).toBe(100n);
  expect(await userState.balance).toBe(60n);
  expect(await userState.nonce).toBe(2n);
  expect(await recipientState.balance).toBe(40n);
  expect({
    balance: await userState.balance,
    nonce: await userState.nonce,
  }).toEqual({
    balance: 60n,
    nonce: 2n,
  });

  const deadlineMs = Date.now() + 5_000;
  while (true) {
    const user = await readAccount({
      abi: abi as Abi,
      token: address,
      account: USER_ACCOUNT.address,
    });
    const recipient = await readAccount({
      abi: abi as Abi,
      token: address,
      account: RECIPIENT_ACCOUNT.address,
    });
    if (
      user.balance === 60n &&
      user.nonce === 2n &&
      recipient.balance === 40n
    ) {
      break;
    }
    if (Date.now() > deadlineMs) {
      throw new Error(
        `token settlement timed out: user=${user.balance}/${user.nonce} recipient=${recipient.balance}/${recipient.nonce}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  await ffca.stop();
});
