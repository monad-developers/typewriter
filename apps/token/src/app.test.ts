import { expect, test } from "bun:test";
import { createFFCA } from "ffca";
import { anvil } from "viem/chains";
import Token from "../contracts/src/Token.sol";
import {
  deployToken,
  RECIPIENT_ACCOUNT,
  SCHEDULER_ACCOUNT,
  TEST_DB_URL,
  TEST_RPC_URL,
  USER_ACCOUNT,
} from "../test/setup";
import { signMint, signTransfer, TOKEN_DOMAIN } from "./app";

test("smoke: FIFO token mint and transfer settle onchain", async () => {
  const { address } = await deployToken();
  const config = {
    address,
    account: SCHEDULER_ACCOUNT,
    chainId: anvil.id,
    rpcUrl: TEST_RPC_URL,
    database: { url: TEST_DB_URL, maxConnections: 4 },
    domain: TOKEN_DOMAIN,
    sequencing: { order: "fifo", submitIntervalMs: 1_000 },
  } as const;
  // biome-ignore lint/suspicious/noExplicitAny: generated Solidity types will replace this temporary app-state escape hatch
  const ffca = (await createFFCA(Token, config)) as any;

  const acceptedMutationIds: number[] = [];
  const includedMutationIds = new Set<number>();
  ffca.on("mutation", (event: { id: number; status: string }) => {
    if (event.status === "accepted") acceptedMutationIds.push(event.id);
  });
  ffca.on("block", (event: { status: string; mutations: { id: number }[] }) => {
    if (event.status !== "included") return;
    for (const mutation of event.mutations) {
      includedMutationIds.add(mutation.id);
    }
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
    params: mint,
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
    params: transfer,
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
    if (includedMutationIds.size === 2) {
      break;
    }
    if (Date.now() > deadlineMs) {
      throw new Error("token settlement timed out");
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
});
