import { expect, test } from "bun:test";
import { createTypewriter, type TypewriterManifest } from "typewriter";
import {
  authorizeMutation,
  getAuthorizationPayload,
  type TypedMutation,
} from "typewriter/client";
import type { Hex } from "viem";
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
import { secp256k1Credential } from "./app";

async function authorize<
  const manifest extends TypewriterManifest,
  const name extends keyof manifest["mutations"] & string,
>(
  manifest: manifest,
  mutation: TypedMutation<manifest, name>,
  signer: (payload: Hex) => Hex | Promise<Hex>,
) {
  return authorizeMutation(
    mutation,
    await signer(getAuthorizationPayload(manifest, mutation)),
  );
}

test("smoke: native accounts mint and transfer settle onchain", async () => {
  const { address } = await deployToken();
  const typewriter = await createTypewriter(Token, {
    address,
    account: SCHEDULER_ACCOUNT,
    chainId: anvil.id,
    rpcUrl: TEST_RPC_URL,
    database: { url: TEST_DB_URL, maxConnections: 4 },
    sequencing: { order: "fifo", submitIntervalMs: 100 },
  });

  try {
    const user = secp256k1Credential(USER_ACCOUNT);
    const recipient = secp256k1Credential(RECIPIENT_ACCOUNT);
    const acceptedMutationIds: number[] = [];
    const includedMutationIds = new Set<number>();
    typewriter.on("mutation", (event) => {
      if (event.status === "accepted") acceptedMutationIds.push(event.id);
    });
    typewriter.on("block", (event) => {
      if (event.status !== "included") return;
      for (const mutation of event.mutations) {
        includedMutationIds.add(mutation.id);
      }
    });

    const userCreate = {
      name: "CreateAccount",
      params: { keyType: user.keyType, publicKey: user.publicKey },
      accountID: user.accountID,
      credentialID: 0n,
      nonce: 0n,
      expiration: 0n,
    } as const satisfies TypedMutation<
      typeof typewriter.manifest,
      "CreateAccount"
    >;
    await typewriter.execute(
      await authorize(typewriter.manifest, userCreate, user.signer),
    );
    const recipientCreate = {
      name: "CreateAccount",
      params: { keyType: recipient.keyType, publicKey: recipient.publicKey },
      accountID: recipient.accountID,
      credentialID: 0n,
      nonce: 0n,
      expiration: 0n,
    } as const satisfies TypedMutation<
      typeof typewriter.manifest,
      "CreateAccount"
    >;
    await typewriter.execute(
      await authorize(typewriter.manifest, recipientCreate, recipient.signer),
    );

    const expiration = BigInt(Math.floor(Date.now() / 1000) + 60);
    const mint = {
      name: "Mint",
      params: { amount: 100n },
      accountID: user.accountID,
      credentialID: 0n,
      nonce: 0n,
      expiration,
    } as const satisfies TypedMutation<typeof typewriter.manifest, "Mint">;
    await typewriter.execute(
      await authorize(typewriter.manifest, mint, user.signer),
    );
    const transfer = {
      name: "Transfer",
      params: { to: recipient.accountID, amount: 40n },
      accountID: user.accountID,
      credentialID: 0n,
      nonce: 1n,
      expiration,
    } as const satisfies TypedMutation<typeof typewriter.manifest, "Transfer">;
    await typewriter.execute(
      await authorize(typewriter.manifest, transfer, user.signer),
    );

    expect(acceptedMutationIds).toHaveLength(4);
    expect(await typewriter.state.totalSupply).toBe(100n);
    expect(await typewriter.state.balances[user.accountID]).toBe(60n);
    expect(await typewriter.state.balances[recipient.accountID]).toBe(40n);
    expect(await typewriter.accounts[user.accountID].nonces["0"]).toBe(2n);
    expect(await typewriter.accounts[user.accountID].activeCredentials).toBe(
      1n,
    );

    const deadlineMs = Date.now() + 5_000;
    while (includedMutationIds.size < 4) {
      if (Date.now() > deadlineMs) {
        throw new Error("token settlement timed out");
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  } finally {
    await typewriter.close();
  }
});
