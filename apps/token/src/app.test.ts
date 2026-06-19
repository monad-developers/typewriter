import { expect, test } from "bun:test";
import { createFFCA } from "ffca";
import {
  type AccountStorage,
  type ConcreteStorageVariable,
  decodeStorageVariable,
  getStorageSlot,
  type StorageVariableToPrimitiveType,
} from "storage-layout";
import {
  type Address,
  type ParseAbiParameters,
  parseAbiParameters,
} from "viem";
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
import {
  signMint,
  signTransfer,
  TOKEN_DOMAIN,
  TOKEN_SIGNATURE_PARAMS,
  type TokenFFCAConfig,
} from "./app";
import { TOKEN_STORAGE_LAYOUT } from "./storage-layout";

async function readAccount(params: {
  token: Address;
  account: Address;
}): Promise<{ nonce: bigint; balance: bigint }> {
  async function readStorage<
    variable extends ConcreteStorageVariable<typeof TOKEN_STORAGE_LAYOUT>,
  >(
    layout: typeof TOKEN_STORAGE_LAYOUT,
    address: Address,
    variable: variable,
  ): Promise<
    StorageVariableToPrimitiveType<typeof TOKEN_STORAGE_LAYOUT, variable>
  > {
    const slots = getStorageSlot(layout, variable);
    const values = await Promise.all(
      slots.map((slot) => TEST_PUBLIC_CLIENT.getStorageAt({ address, slot })),
    );
    const storage = Object.fromEntries(
      slots.map((slot, index) => [slot, values[index]!]),
    ) as AccountStorage;

    return decodeStorageVariable(layout, variable, storage);
  }

  return {
    nonce: await readStorage(
      TOKEN_STORAGE_LAYOUT,
      params.token,
      `accounts[${params.account}].nonce`,
    ),
    balance: await readStorage(
      TOKEN_STORAGE_LAYOUT,
      params.token,
      `accounts[${params.account}].balance`,
    ),
  };
}

test("smoke: FIFO token mint and transfer settle onchain", async () => {
  const { address } = await deployToken();
  const config = {
    address,
    signature: { params: TOKEN_SIGNATURE_PARAMS },
    storageLayout: TOKEN_STORAGE_LAYOUT,
    account: SCHEDULER_ACCOUNT,
    chainId: anvil.id,
    rpcUrl: TEST_RPC_URL,
    database: { url: TEST_DB_URL, maxConnections: 4 },
    domain: TOKEN_DOMAIN,
    sequencing: { order: "fifo", submitIntervalMs: 1_000 },
    mutations: {
      Transfer: {
        tag: 0,
        params: parseAbiParameters(
          "address from, address to, uint256 amount, uint256 nonce, uint256 deadline",
        ),
      },
      Mint: {
        tag: 1,
        params: parseAbiParameters(
          "address to, uint256 amount, uint256 nonce, uint256 deadline",
        ),
      },
    },
  } as const satisfies TokenFFCAConfig;
  const ffca = await createFFCA<
    typeof TOKEN_STORAGE_LAYOUT,
    {
      Transfer: {
        params: ParseAbiParameters<"address from, address to, uint256 amount, uint256 nonce, uint256 deadline">;
      };
      Mint: {
        params: ParseAbiParameters<"address to, uint256 amount, uint256 nonce, uint256 deadline">;
      };
    },
    typeof TOKEN_SIGNATURE_PARAMS
  >(config);

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
    const user = await readAccount({
      token: address,
      account: USER_ACCOUNT.address,
    });
    const recipient = await readAccount({
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
});
