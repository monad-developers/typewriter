import { expect, test } from "bun:test";
import { drizzle } from "drizzle-orm/bun-sql/postgres";
import { createFFCA } from "ffca";
import {
  ALL_PERMISSIONS,
  EIP712_TYPES,
  EXCHANGE_STORAGE_LAYOUT,
} from "order-book-sdk";
import { type Address, encodeAbiParameters, type Hex, keccak256 } from "viem";
import { signTypedData } from "viem/accounts";
import { anvil } from "viem/chains";
import {
  deployExchange,
  MAKER_ACCOUNT,
  MAKER_PRIVATE_KEY,
  SCHEDULER_ACCOUNT,
  TEST_DB_CONNECTION,
  TEST_DB_URL,
  TEST_RPC_URL,
} from "../test/setup";
import {
  normalizeSignatureForContract,
  ORDER_BOOK_BATCH_ORDER,
  ORDER_BOOK_MUTATIONS,
  ORDER_BOOK_SIGNATURE_PARAMS,
  type SubmittedOrderBookMutation,
} from "./app";
import {
  selectBlock,
  selectMutationById,
  selectMutationsByAccount,
  selectMutationsByBlock,
} from "./db-queries";

const BASE: Address = "0x1111111111111111111111111111111111111111";
const QUOTE: Address = "0x2222222222222222222222222222222222222222";
const Q32 = 1n << 32n;
const FAR_DEADLINE = BigInt(Math.floor(Date.now() / 1000) + 86_400);
type OrderBookFFCA = Awaited<ReturnType<typeof createOrderBookFFCA>>;

async function createOrderBookFFCA(
  address: Hex,
  options: { submitIntervalMs?: number } = {},
) {
  return createFFCA<
    typeof EXCHANGE_STORAGE_LAYOUT,
    typeof ORDER_BOOK_MUTATIONS,
    typeof ORDER_BOOK_SIGNATURE_PARAMS
  >({
    address,
    domain: { name: "Exchange", version: "1" },
    signature: { params: ORDER_BOOK_SIGNATURE_PARAMS },
    storageLayout: EXCHANGE_STORAGE_LAYOUT,
    account: SCHEDULER_ACCOUNT,
    chainId: anvil.id,
    rpcUrl: TEST_RPC_URL,
    database: { url: TEST_DB_URL, maxConnections: 4 },
    sequencing: {
      order: "batch",
      batchOrder: ORDER_BOOK_BATCH_ORDER,
      submitIntervalMs: options.submitIntervalMs ?? 60_000,
    },
    mutations: ORDER_BOOK_MUTATIONS,
  });
}

function secp256k1PublicKey(address: Address): Hex {
  return encodeAbiParameters([{ type: "address" }], [address]);
}

function accountId(publicKey: Hex): Hex {
  return keccak256(publicKey);
}

function messageFor(name: string, params: Record<string, unknown>) {
  switch (name) {
    case "Initialize":
      return {
        account: params.account,
        expiry: params.expiry,
        rootKeyType: params.rootKeyType,
        keyType: params.keyType,
        permissions: params.permissions,
        rootPublicKey: params.rootPublicKey,
        publicKey: params.publicKey,
      };
    case "Authorize":
      return {
        account: params.account,
        expiry: params.expiry,
        keyType: params.keyType,
        permissions: params.permissions,
        publicKey: params.publicKey,
        nonce: params.nonce,
        deadline: params.deadline,
      };
    case "Revoke":
      return {
        account: params.account,
        keyId: params.keyId,
        nonce: params.nonce,
        deadline: params.deadline,
      };
    case "CloseOrder":
      return {
        orderId: BigInt(params.orderId as number),
        nonce: params.nonce,
        deadline: params.deadline,
      };
    case "ChangeOrder":
      return {
        orderId: BigInt(params.orderId as number),
        price: params.price,
        nonce: params.nonce,
        deadline: params.deadline,
      };
    case "LimitOrder":
      return {
        quantity: params.quantity,
        instrumentId: BigInt(params.instrumentId as number),
        price: params.price,
        bidOrAsk: params.bidOrAsk,
        nonce: params.nonce,
        deadline: params.deadline,
      };
    case "MarketOrder":
      return {
        quantity: params.quantity,
        minReceivedQuantity: params.minReceivedQuantity,
        instrumentId: BigInt(params.instrumentId as number),
        bidOrAsk: params.bidOrAsk,
        nonce: params.nonce,
        deadline: params.deadline,
      };
    case "AddInstrument":
      return {
        instrumentId: BigInt(params.instrumentId as number),
        base: params.base,
        quote: params.quote,
        baseLotExp: params.baseLotExp,
        quoteLotExp: params.quoteLotExp,
        nonce: params.nonce,
        deadline: params.deadline,
      };
    case "Deposit":
    case "Withdrawal":
      return {
        asset: params.asset,
        amount: params.amount,
        nonce: params.nonce,
        deadline: params.deadline,
      };
  }
}

async function signedMutation<const name extends string>(input: {
  name: name;
  params: Extract<SubmittedOrderBookMutation, { name: name }>["params"];
  signerKeyId: bigint;
  privateKey: Hex;
  address: Address;
  account: Hex;
}): Promise<Extract<SubmittedOrderBookMutation, { name: name }>> {
  const rawSignature =
    input.name === "Initialize"
      ? "0x"
      : await signTypedData({
          privateKey: input.privateKey,
          domain: {
            name: "Exchange",
            version: "1",
            chainId: anvil.id,
            verifyingContract: input.address,
          },
          types: EIP712_TYPES,
          primaryType: input.name,
          message: messageFor(
            input.name,
            input.params as Record<string, unknown>,
          ),
        } as never);
  return {
    name: input.name,
    params: input.params,
    signature: {
      account: input.account,
      keyId: input.signerKeyId,
      rawSignature,
    },
  } as Extract<SubmittedOrderBookMutation, { name: name }>;
}

async function setupAccount(params: {
  app: OrderBookFFCA;
  account: Address;
  privateKey: Hex;
  contract: Address;
}): Promise<Hex> {
  const publicKey = secp256k1PublicKey(params.account);
  const id = accountId(publicKey);
  await executeOrderBookMutation(
    params.app,
    await signedMutation({
      name: "Initialize",
      address: params.contract,
      privateKey: params.privateKey,
      signerKeyId: 0n,
      account: id,
      params: {
        account: id,
        expiry: 0,
        rootKeyType: 2,
        keyType: 2,
        permissions: ALL_PERMISSIONS,
        rootPublicKey: publicKey,
        publicKey,
      },
    }),
  );
  return id;
}

function executeOrderBookMutation(
  app: OrderBookFFCA,
  submitted: SubmittedOrderBookMutation,
) {
  return app.execute({
    ...submitted,
    signature: normalizeSignatureForContract(submitted.signature),
  } as Parameters<OrderBookFFCA["execute"]>[0]);
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

test("ffca order book rejects invalid signatures before applying", async () => {
  const address = await deployExchange();
  const app = await createOrderBookFFCA(address);

  const maker = await setupAccount({
    app,
    account: MAKER_ACCOUNT.address,
    privateKey: MAKER_PRIVATE_KEY,
    contract: address,
  });
  const signed = await signedMutation({
    name: "Deposit",
    address,
    privateKey: MAKER_PRIVATE_KEY,
    signerKeyId: 1n,
    account: maker,
    params: {
      asset: BASE,
      amount: 11n,
      nonce: 0n,
      deadline: FAR_DEADLINE,
    },
  });

  await expect(
    executeOrderBookMutation(app, {
      ...signed,
      params: {
        asset: BASE,
        amount: 10n,
        nonce: 0n,
        deadline: FAR_DEADLINE,
      },
    }),
  ).rejects.toThrow(/reverted/);
});

test("ffca order book changes an unfilled order to a new price", async () => {
  const address = await deployExchange();
  const app = await createOrderBookFFCA(address);

  const maker = await setupAccount({
    app,
    account: MAKER_ACCOUNT.address,
    privateKey: MAKER_PRIVATE_KEY,
    contract: address,
  });
  await executeOrderBookMutation(
    app,
    await signedMutation({
      name: "AddInstrument",
      address,
      privateKey: MAKER_PRIVATE_KEY,
      signerKeyId: 1n,
      account: maker,
      params: {
        instrumentId: 0n,
        base: BASE,
        quote: QUOTE,
        baseLotExp: 0,
        quoteLotExp: 0,
        nonce: 0n,
        deadline: FAR_DEADLINE,
      },
    }),
  );
  await executeOrderBookMutation(
    app,
    await signedMutation({
      name: "Deposit",
      address,
      privateKey: MAKER_PRIVATE_KEY,
      signerKeyId: 1n,
      account: maker,
      params: {
        asset: QUOTE,
        amount: 100n,
        nonce: 1n,
        deadline: FAR_DEADLINE,
      },
    }),
  );
  await executeOrderBookMutation(
    app,
    await signedMutation({
      name: "LimitOrder",
      address,
      privateKey: MAKER_PRIVATE_KEY,
      signerKeyId: 1n,
      account: maker,
      params: {
        quantity: 10n,
        instrumentId: 0n,
        price: 5n * Q32,
        bidOrAsk: 0,
        nonce: 2n,
        deadline: FAR_DEADLINE,
      },
    }),
  );

  const result = await executeOrderBookMutation(
    app,
    await signedMutation({
      name: "ChangeOrder",
      address,
      privateKey: MAKER_PRIVATE_KEY,
      signerKeyId: 1n,
      account: maker,
      params: {
        orderId: 0n,
        price: 6n * Q32,
        nonce: 3n,
        deadline: FAR_DEADLINE,
      },
    }),
  );
  expect(result.id).toBeGreaterThanOrEqual(0);
});

test("db-queries fan out across per-mutation tables", async () => {
  const address = await deployExchange();
  const app = await createOrderBookFFCA(address, { submitIntervalMs: 400 });
  const schema = app.schema;
  const db = drizzle({
    client: TEST_DB_CONNECTION,
  });

  const maker = await setupAccount({
    app,
    account: MAKER_ACCOUNT.address,
    privateKey: MAKER_PRIVATE_KEY,
    contract: address,
  });
  await executeOrderBookMutation(
    app,
    await signedMutation({
      name: "AddInstrument",
      address,
      privateKey: MAKER_PRIVATE_KEY,
      signerKeyId: 1n,
      account: maker,
      params: {
        instrumentId: 0n,
        base: BASE,
        quote: QUOTE,
        baseLotExp: 0,
        quoteLotExp: 0,
        nonce: 0n,
        deadline: FAR_DEADLINE,
      },
    }),
  );
  await executeOrderBookMutation(
    app,
    await signedMutation({
      name: "Deposit",
      address,
      privateKey: MAKER_PRIVATE_KEY,
      signerKeyId: 1n,
      account: maker,
      params: {
        asset: BASE,
        amount: 7n,
        nonce: 1n,
        deadline: FAR_DEADLINE,
      },
    }),
  );

  await waitForIncluded(db, schema.deposit_mutations, "deposit");

  const [depositRowRaw] = await db
    .select()
    .from(schema.deposit_mutations)
    .limit(1);
  expect(depositRowRaw).toBeDefined();
  // FFCA returns numeric(78,0) columns as bigint (block number, block
  // timestamp, etc.); the API layer stringifies them at the wire boundary.
  const depositRow = depositRowRaw as unknown as {
    id: number;
    blockNumber: bigint;
    blockHash: string;
    blockTimestamp: bigint;
  };
  const blockNumber = depositRow.blockNumber.toString();

  // selectBlock: any per-type table referencing this block returns its metadata.
  const block = await selectBlock(db, schema, blockNumber);
  expect(block).toMatchObject({
    number: blockNumber,
    hash: depositRow.blockHash,
    timestamp: depositRow.blockTimestamp.toString(),
  });

  // selectMutationById: globally unique id resolves through the right table.
  const byId = await selectMutationById(db, schema, depositRow.id);
  expect(byId).toMatchObject({
    id: depositRow.id,
    status: "included",
    signature_account: maker,
    nonce: 1n,
    blockNumber: depositRow.blockNumber,
  });
  expect(byId).toMatchObject({ asset: BASE, amount: 7n });

  // selectMutationsByBlock: returns every persisted mutation that landed in
  // the block, ordered by mutation id.
  const inBlock = await selectMutationsByBlock(db, schema, blockNumber);
  expect(inBlock.length).toBeGreaterThanOrEqual(1);
  const idsInBlock = new Set(inBlock.map((m) => m.id));
  expect(idsInBlock.has(depositRow.id)).toBe(true);

  // selectMutationsByAccount: most recent N mutations for this account across
  // all per-type tables, ordered by id desc.
  const recent = await selectMutationsByAccount(db, schema, maker, 10);
  expect(recent[0]?.id).toBe(depositRow.id);
  expect(recent.every((m) => m.signature_account === maker)).toBe(true);

  // 404 paths.
  expect(await selectBlock(db, schema, "999999")).toBeNull();
  expect(await selectMutationById(db, schema, 999_999)).toBeNull();
});
