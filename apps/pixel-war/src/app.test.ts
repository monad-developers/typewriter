import { expect, test } from "bun:test";
import { drizzle } from "drizzle-orm/bun-sql/postgres";
import { ENERGY_PER_EPOCH, toPixelIndex, wordOfPixel } from "pixel-war-sdk";
import { createTypewriter } from "typewriter";
import type { Address, Hex } from "viem";
import { anvil } from "viem/chains";
import PixelWar from "../contracts/src/PixelWar.sol";
import {
  ALICE_ACCOUNT,
  BOB_ACCOUNT,
  deployPixelWar,
  SCHEDULER_ACCOUNT,
  TEST_DB_CONNECTION,
  TEST_DB_URL,
  TEST_RPC_URL,
} from "../test/setup";
import {
  EPOCH_NONCE_LANE,
  initializeMutation,
  MAX_DEADLINE,
  nonceFor,
  PIXEL_WAR_BATCH_ORDER,
  secp256k1AccountId,
  signMutation,
} from "./app";
import { Canvas, type StateReader } from "./canvas";
import { selectLeaderboard, selectPixelHistory } from "./db-queries";

type PixelWarApp = Awaited<ReturnType<typeof createPixelWar>>;

async function createPixelWar(
  address: Address,
  options: { submitIntervalMs?: number; batchIntervalMs?: number } = {},
) {
  return await createTypewriter(PixelWar, {
    address,
    account: SCHEDULER_ACCOUNT,
    chainId: anvil.id,
    rpcUrl: TEST_RPC_URL,
    database: { url: TEST_DB_URL, maxConnections: 4 },
    sequencing: {
      order: "batch",
      batchOrder: PIXEL_WAR_BATCH_ORDER,
      batchIntervalMs: options.batchIntervalMs ?? 50,
      submitIntervalMs: options.submitIntervalMs ?? 60_000,
    },
  });
}

/// Registers a secp256k1 account whose key slot 1 signs mutations.
async function register(app: PixelWarApp, address: Address): Promise<Hex> {
  await app.execute(
    initializeMutation(address) as Parameters<PixelWarApp["execute"]>[0],
  );
  return secp256k1AccountId(address);
}

type Signer = { account: typeof ALICE_ACCOUNT; id: Hex };

async function submit(
  app: PixelWarApp,
  contract: Address,
  signer: Signer,
  name: "Paint" | "Shield" | "Bomb" | "AdvanceEpoch",
  params: Record<string, unknown>,
) {
  const signed = await signMutation({
    name,
    params,
    account: signer.account,
    signerAccountId: signer.id,
    keyId: 1n,
    contract,
    chainId: anvil.id,
  });
  return app.execute(signed as Parameters<PixelWarApp["execute"]>[0]);
}

/// `canvas` is a `uint256[256]`, and abitype cannot build a 256-element tuple
/// type, so the generated proxy types that leaf as an opaque value. Reads work at
/// runtime; the cast is the same seam `Canvas` uses.
function canvasWords(app: PixelWarApp): Record<number, Promise<bigint>> {
  return app.state.canvas as unknown as Record<number, Promise<bigint>>;
}

async function pixelAt(
  app: PixelWarApp,
  x: number,
  y: number,
): Promise<number> {
  const index = toPixelIndex(x, y);
  const word = await canvasWords(app)[wordOfPixel(index)]!;
  const shift = BigInt((index % 64) * 4);
  return Number((BigInt(word) >> shift) & 0xfn);
}

async function teamOf(app: PixelWarApp, account: Hex): Promise<number> {
  return Number(await app.state.accounts[account].team);
}

function colorFor(team: number): number {
  return 1 + 3 * team;
}

/// Polls `read` until `done` holds, for read models that land shortly after a
/// mutation is accepted.
async function waitFor<T>(
  read: () => Promise<T>,
  done: (value: T) => boolean,
  timeoutMs = 5000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let value = await read();
  while (!done(value) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    value = await read();
  }
  return value;
}

test("paint writes a packed pixel and credits the team", async () => {
  const address = await deployPixelWar();
  const app = await createPixelWar(address);
  const alice: Signer = {
    account: ALICE_ACCOUNT,
    id: await register(app, ALICE_ACCOUNT.address),
  };
  const color = colorFor(await teamOf(app, alice.id));

  await submit(app, address, alice, "Paint", {
    x: 10,
    y: 20,
    color,
    nonce: nonceFor(0n, 0n),
    deadline: MAX_DEADLINE,
  });

  expect(await pixelAt(app, 10, 20)).toBe(color);
  expect(Number(await app.state.teamPixels[await teamOf(app, alice.id)])).toBe(
    1,
  );
  await app.close();
});

/// The batch order is the whole point of the app: a shield submitted *after* an
/// incoming paint still resolves first, because within a batch every Shield is
/// ordered ahead of every Paint.
test("a shield submitted after a paint still wins the tick", async () => {
  const address = await deployPixelWar();
  const app = await createPixelWar(address, { batchIntervalMs: 250 });

  const alice: Signer = {
    account: ALICE_ACCOUNT,
    id: await register(app, ALICE_ACCOUNT.address),
  };
  const bob: Signer = {
    account: BOB_ACCOUNT,
    id: await register(app, BOB_ACCOUNT.address),
  };
  const aliceColor = colorFor(await teamOf(app, alice.id));
  const bobColor = colorFor(await teamOf(app, bob.id));

  await submit(app, address, alice, "Paint", {
    x: 5,
    y: 5,
    color: aliceColor,
    nonce: nonceFor(0n, 0n),
    deadline: MAX_DEADLINE,
  });

  // Both land in the same batch window. Bob's paint is submitted first.
  const paint = submit(app, address, bob, "Paint", {
    x: 5,
    y: 5,
    color: bobColor,
    nonce: nonceFor(0n, 0n),
    deadline: MAX_DEADLINE,
  });
  const shield = submit(app, address, alice, "Shield", {
    x: 5,
    y: 5,
    nonce: nonceFor(0n, 1n),
    deadline: MAX_DEADLINE,
  });
  await Promise.all([paint, shield]);

  expect(await pixelAt(app, 5, 5)).toBe(aliceColor);
  expect(Number(await app.state.shields[`${toPixelIndex(5, 5)}`])).toBe(0);
  await app.close();
});

test("a bomb submitted before a paint still buries it", async () => {
  const address = await deployPixelWar();
  const app = await createPixelWar(address, { batchIntervalMs: 250 });

  const alice: Signer = {
    account: ALICE_ACCOUNT,
    id: await register(app, ALICE_ACCOUNT.address),
  };
  const bob: Signer = {
    account: BOB_ACCOUNT,
    id: await register(app, BOB_ACCOUNT.address),
  };
  const aliceColor = colorFor(await teamOf(app, alice.id));
  const bobColor = colorFor(await teamOf(app, bob.id));

  const bomb = submit(app, address, bob, "Bomb", {
    x: 60,
    y: 60,
    color: bobColor,
    nonce: nonceFor(0n, 0n),
    deadline: MAX_DEADLINE,
  });
  const paint = submit(app, address, alice, "Paint", {
    x: 60,
    y: 60,
    color: aliceColor,
    nonce: nonceFor(0n, 0n),
    deadline: MAX_DEADLINE,
  });
  await Promise.all([bomb, paint]);

  expect(await pixelAt(app, 60, 60)).toBe(bobColor);
  await app.close();
});

test("energy caps actions per epoch and the authority refills it", async () => {
  const address = await deployPixelWar();
  const app = await createPixelWar(address);

  const alice: Signer = {
    account: ALICE_ACCOUNT,
    id: await register(app, ALICE_ACCOUNT.address),
  };
  const authority: Signer = {
    account: SCHEDULER_ACCOUNT,
    id: await register(app, SCHEDULER_ACCOUNT.address),
  };
  const color = colorFor(await teamOf(app, alice.id));

  for (let i = 0; i < ENERGY_PER_EPOCH; i++) {
    await submit(app, address, alice, "Paint", {
      x: i,
      y: 30,
      color,
      nonce: nonceFor(0n, BigInt(i)),
      deadline: MAX_DEADLINE,
    });
  }
  expect(Number(await app.state.accounts[alice.id].energy)).toBe(0);

  await expect(
    submit(app, address, alice, "Paint", {
      x: 100,
      y: 30,
      color,
      nonce: nonceFor(0n, BigInt(ENERGY_PER_EPOCH)),
      deadline: MAX_DEADLINE,
    }),
  ).rejects.toThrow(/reverted/);

  await submit(app, address, authority, "AdvanceEpoch", {
    epoch: 1n,
    nonce: nonceFor(EPOCH_NONCE_LANE, 0n),
    deadline: MAX_DEADLINE,
  });
  expect(Number(await app.state.epoch)).toBe(1);

  // The rejected paint above reverted, so its nonce was never consumed.
  await submit(app, address, alice, "Paint", {
    x: 100,
    y: 30,
    color,
    nonce: nonceFor(0n, BigInt(ENERGY_PER_EPOCH)),
    deadline: MAX_DEADLINE,
  });
  expect(await pixelAt(app, 100, 30)).toBe(color);
  await app.close();
});

test("only the epoch authority can move the epoch", async () => {
  const address = await deployPixelWar();
  const app = await createPixelWar(address);
  const alice: Signer = {
    account: ALICE_ACCOUNT,
    id: await register(app, ALICE_ACCOUNT.address),
  };

  await expect(
    submit(app, address, alice, "AdvanceEpoch", {
      epoch: 1n,
      nonce: nonceFor(9n, 0n),
      deadline: MAX_DEADLINE,
    }),
  ).rejects.toThrow(/reverted/);
  await app.close();
});

test("the canvas mirror reads deltas back out of runtime state", async () => {
  const address = await deployPixelWar();
  const app = await createPixelWar(address);
  const alice: Signer = {
    account: ALICE_ACCOUNT,
    id: await register(app, ALICE_ACCOUNT.address),
  };
  const color = colorFor(await teamOf(app, alice.id));

  const canvas = new Canvas(app.state as unknown as StateReader);
  await canvas.load();
  expect(canvas.colors[toPixelIndex(7, 7)]).toBe(0);

  await submit(app, address, alice, "Paint", {
    x: 7,
    y: 7,
    color,
    nonce: nonceFor(0n, 0n),
    deadline: MAX_DEADLINE,
  });

  canvas.touch({ name: "Paint", params: { x: 7, y: 7, color } });
  const flush = await canvas.flush();

  expect(flush?.pixels).toEqual([{ index: toPixelIndex(7, 7), color }]);
  expect(canvas.colors[toPixelIndex(7, 7)]).toBe(color);
  expect(await canvas.flush()).toBeNull();
  await app.close();
});

test("generated mutation tables back the pixel history and leaderboard", async () => {
  const address = await deployPixelWar();
  const app = await createPixelWar(address, { submitIntervalMs: 400 });
  const db = drizzle({ client: TEST_DB_CONNECTION });

  const alice: Signer = {
    account: ALICE_ACCOUNT,
    id: await register(app, ALICE_ACCOUNT.address),
  };
  const color = colorFor(await teamOf(app, alice.id));

  await submit(app, address, alice, "Paint", {
    x: 12,
    y: 34,
    color,
    nonce: nonceFor(0n, 0n),
    deadline: MAX_DEADLINE,
  });
  await submit(app, address, alice, "Bomb", {
    x: 13,
    y: 34,
    color,
    nonce: nonceFor(0n, 1n),
    deadline: MAX_DEADLINE,
  });

  // Mutation rows are written just after acceptance, so give persistence a
  // moment to catch up before asserting on the read model.
  const history = await waitFor(
    () => selectPixelHistory(db, app.schema, 12, 34, 10),
    (rows) => rows.length === 2,
  );
  expect(history.map((row) => row.name)).toEqual(["Bomb", "Paint"]);
  expect(history[0]?.account).toBe(alice.id);

  const leaderboard = await selectLeaderboard(db, app.schema, 10);
  expect(leaderboard).toEqual([
    { account: alice.id, paints: 1, shields: 0, bombs: 1, total: 2 },
  ]);
  await app.close();
});
