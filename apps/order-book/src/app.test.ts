import { expect, test } from "bun:test";
import { drizzle } from "drizzle-orm/bun-sql/postgres";
import { Hex as OxHex, Secp256k1, Signature } from "ox";
import { createTypewriter } from "typewriter";
import {
  authorizeMutation,
  deriveAccountID,
  getAuthorizationPayload,
  type TypedMutation,
} from "typewriter/client";
import { type Address, encodeAbiParameters, type Hex } from "viem";
import { anvil } from "viem/chains";
import OrderBook from "../contracts/src/OrderBook.sol";
import {
  deployOrderBook,
  MAKER_ACCOUNT,
  MAKER_PRIVATE_KEY,
  SCHEDULER_ACCOUNT,
  TEST_DB_CONNECTION,
  TEST_DB_URL,
  TEST_RPC_URL,
} from "../test/setup";
import { ORDER_BOOK_BATCH_ORDER } from "./app";
import {
  selectBlock,
  selectMutationById,
  selectMutationsByAccount,
  selectMutationsByBlock,
} from "./db-queries";

const BASE: Address = "0x1111111111111111111111111111111111111111";
const QUOTE: Address = "0x2222222222222222222222222222222222222222";
const Q32 = 1n << 32n;
const FAR_EXPIRATION = 0n;
type OrderBookTypewriter = Awaited<
  ReturnType<typeof createOrderBookTypewriter>
>;
type OrderBookMutationInput = Parameters<OrderBookTypewriter["execute"]>[0];

async function createOrderBookTypewriter(
  address: Hex,
  options: { submitIntervalMs?: number } = {},
) {
  return await createTypewriter(OrderBook, {
    address,
    account: SCHEDULER_ACCOUNT,
    chainId: anvil.id,
    rpcUrl: TEST_RPC_URL,
    database: { url: TEST_DB_URL, maxConnections: 4 },
    sequencing: {
      order: "batch",
      batchOrder: ORDER_BOOK_BATCH_ORDER,
      submitIntervalMs: options.submitIntervalMs ?? 60_000,
    },
  });
}

function secp256k1PublicKey(address: Address): Hex {
  return encodeAbiParameters([{ type: "address" }], [address]);
}

function signAuthorization(privateKey: Hex, payload: Hex): Hex {
  const signature = Secp256k1.sign({
    payload: payload as OxHex.Hex,
    privateKey: privateKey as OxHex.Hex,
  });
  return encodeAbiParameters(
    [{ type: "uint8" }, { type: "bytes32" }, { type: "bytes32" }],
    [
      Signature.yParityToV(signature.yParity),
      OxHex.fromNumber(signature.r, { size: 32 }),
      OxHex.fromNumber(signature.s, { size: 32 }),
    ],
  );
}

async function setupAccount(app: OrderBookTypewriter): Promise<Hex> {
  const params = {
    keyType: 2,
    publicKey: secp256k1PublicKey(MAKER_ACCOUNT.address),
  } as const;
  const accountID = deriveAccountID(params);
  const mutation = {
    name: "CreateAccount",
    params,
    accountID,
    credentialID: 0n,
    nonce: 0n,
    expiration: 0n,
  } as const satisfies TypedMutation<typeof app.manifest, "CreateAccount">;
  const authorization = authorizeMutation(
    mutation,
    signAuthorization(
      MAKER_PRIVATE_KEY,
      getAuthorizationPayload(app.manifest, mutation),
    ),
  );
  await app.execute(authorization);
  return accountID;
}

async function signedMutation<
  const name extends keyof OrderBookTypewriter["manifest"]["mutations"] &
    string,
>(params: {
  app: OrderBookTypewriter;
  name: name;
  params: Record<string, unknown>;
  accountID: Hex;
  nonce: bigint;
}): Promise<OrderBookMutationInput> {
  const mutation = {
    name: params.name,
    params: params.params,
    accountID: params.accountID,
    credentialID: 0n,
    nonce: params.nonce,
    expiration: FAR_EXPIRATION,
  } as unknown as TypedMutation<typeof params.app.manifest, name>;
  return authorizeMutation(
    mutation,
    signAuthorization(
      MAKER_PRIVATE_KEY,
      getAuthorizationPayload(params.app.manifest, mutation),
    ),
  ) as unknown as OrderBookMutationInput;
}

async function waitForIncluded(
  db: ReturnType<typeof drizzle>,
  table: unknown,
  label: string,
) {
  // biome-ignore lint/suspicious/noExplicitAny: helper polls different mutation tables with shared status column
  const mutationTable = table as any;
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const [row] = await db.select().from(mutationTable).limit(1);
    if (row?.status === "included") return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`${label} never reached included`);
}

test("typewriter order book rejects a tampered mutation payload", async () => {
  const address = await deployOrderBook();
  const app = await createOrderBookTypewriter(address);
  const accountID = await setupAccount(app);
  const signed = await signedMutation({
    app,
    name: "Deposit",
    accountID,
    nonce: 0n,
    params: { asset: BASE, amount: 11n },
  });

  await expect(
    app.execute({
      ...signed,
      params: { asset: BASE, amount: 10n },
    } as Parameters<OrderBookTypewriter["execute"]>[0]),
  ).rejects.toThrow(/reverted/);
});

test("typewriter order book changes an unfilled order to a new price", async () => {
  const address = await deployOrderBook();
  const app = await createOrderBookTypewriter(address);
  const accountID = await setupAccount(app);
  await app.execute(
    await signedMutation({
      app,
      name: "AddInstrument",
      accountID,
      nonce: 0n,
      params: {
        instrumentId: 0n,
        base: BASE,
        quote: QUOTE,
        baseLotExp: 0,
        quoteLotExp: 0,
      },
    }),
  );
  await app.execute(
    await signedMutation({
      app,
      name: "Deposit",
      accountID,
      nonce: 1n,
      params: { asset: QUOTE, amount: 100n },
    }),
  );
  await app.execute(
    await signedMutation({
      app,
      name: "LimitOrder",
      accountID,
      nonce: 2n,
      params: { quantity: 10n, instrumentId: 0n, price: 5n * Q32, bidOrAsk: 0 },
    }),
  );

  const result = await app.execute(
    await signedMutation({
      app,
      name: "ChangeOrder",
      accountID,
      nonce: 3n,
      params: { orderId: 0n, price: 6n * Q32 },
    }),
  );
  expect(result.id).toBeGreaterThanOrEqual(0);
});

test("db-queries fan out across per-mutation tables", async () => {
  const address = await deployOrderBook();
  const app = await createOrderBookTypewriter(address, {
    submitIntervalMs: 400,
  });
  const schema = app.schema;
  const db = drizzle({ client: TEST_DB_CONNECTION });
  const accountID = await setupAccount(app);
  await app.execute(
    await signedMutation({
      app,
      name: "AddInstrument",
      accountID,
      nonce: 0n,
      params: {
        instrumentId: 0n,
        base: BASE,
        quote: QUOTE,
        baseLotExp: 0,
        quoteLotExp: 0,
      },
    }),
  );
  await app.execute(
    await signedMutation({
      app,
      name: "Deposit",
      accountID,
      nonce: 1n,
      params: { asset: BASE, amount: 7n },
    }),
  );

  await waitForIncluded(db, schema.deposit_mutations, "deposit");
  const [depositRowRaw] = await db
    .select()
    .from(schema.deposit_mutations)
    .limit(1);
  expect(depositRowRaw).toBeDefined();
  const depositRow = depositRowRaw as unknown as {
    id: number;
    blockNumber: bigint;
    blockHash: string;
    blockTimestamp: bigint;
  };
  const blockNumber = depositRow.blockNumber.toString();
  const block = await selectBlock(db, schema, blockNumber);
  expect(block).toMatchObject({
    number: blockNumber,
    hash: depositRow.blockHash,
    timestamp: depositRow.blockTimestamp.toString(),
  });
  const byId = await selectMutationById(db, schema, depositRow.id);
  expect(byId).toMatchObject({
    id: depositRow.id,
    status: "included",
    authorization_account_id: accountID,
    authorization_nonce: 1n,
    blockNumber: depositRow.blockNumber,
  });
  expect(byId).toMatchObject({ asset: BASE, amount: 7n });
  const inBlock = await selectMutationsByBlock(db, schema, blockNumber);
  expect(
    new Set(inBlock.map((mutation) => mutation.id)).has(depositRow.id),
  ).toBe(true);
  const recent = await selectMutationsByAccount(db, schema, accountID, 10);
  expect(recent[0]?.id).toBe(depositRow.id);
  expect(
    recent.every((mutation) => mutation.authorization_account_id === accountID),
  ).toBe(true);
  expect(await selectBlock(db, schema, "999999")).toBeNull();
  expect(await selectMutationById(db, schema, 999_999)).toBeNull();
});
