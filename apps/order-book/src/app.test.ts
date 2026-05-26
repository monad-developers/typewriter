import { expect, test } from "bun:test";
import { drizzle } from "drizzle-orm/bun-sql/postgres";
import { createFFCA } from "ffca";
import {
  EIP712_TYPES,
  EXCHANGE_ABI,
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
  type OrderBookFFCAConfig,
  type OrderBookMutationName,
  type SubmittedOrderBookMutation,
} from "./app";
import {
  loadBlock,
  loadMutationByAccountNonce,
  loadMutationById,
  loadMutationsByAccount,
  loadMutationsByBlock,
} from "./db-queries";
import { ALL_PERMISSIONS } from "./exchange";

const BASE: Address = "0x1111111111111111111111111111111111111111";
const QUOTE: Address = "0x2222222222222222222222222222222222222222";
const Q32 = 1n << 32n;
const FAR_DEADLINE = BigInt(Math.floor(Date.now() / 1000) + 86_400);
type OrderBookFFCA = Awaited<ReturnType<typeof createOrderBookFFCA>>;

async function createOrderBookFFCA(address: Hex) {
  const config = {
    address,
    domain: { name: "Exchange", version: "1" },
    abi: EXCHANGE_ABI,
    storageLayout: EXCHANGE_STORAGE_LAYOUT,
    account: SCHEDULER_ACCOUNT,
    chainId: anvil.id,
    rpcUrl: TEST_RPC_URL,
    database: { url: TEST_DB_URL, maxConnections: 4 },
    sequencing: {
      order: "batch",
      batchOrder: ORDER_BOOK_BATCH_ORDER,
    },
    mutations: ORDER_BOOK_MUTATIONS,
  } as const satisfies OrderBookFFCAConfig;

  return createFFCA(config);
}

function secp256k1PublicKey(address: Address): Hex {
  return encodeAbiParameters([{ type: "address" }], [address]);
}

function accountId(publicKey: Hex): Hex {
  return keccak256(publicKey);
}

function messageFor(
  name: OrderBookMutationName,
  args: Record<string, unknown>,
) {
  switch (name) {
    case "Initialize":
      return {
        account: args.account,
        expiry: args.expiry,
        rootKeyType: args.rootKeyType,
        keyType: args.keyType,
        permissions: args.permissions,
        rootPublicKey: args.rootPublicKey,
        publicKey: args.publicKey,
      };
    case "Authorize":
      return {
        account: args.account,
        expiry: args.expiry,
        keyType: args.keyType,
        permissions: args.permissions,
        publicKey: args.publicKey,
        nonce: args.nonce,
        deadline: args.deadline,
      };
    case "Revoke":
      return {
        account: args.account,
        keyId: BigInt(args.keyId as number),
        nonce: args.nonce,
        deadline: args.deadline,
      };
    case "CloseOrder":
      return {
        orderId: BigInt(args.orderId as number),
        nonce: args.nonce,
        deadline: args.deadline,
      };
    case "ChangeOrder":
      return {
        orderId: BigInt(args.orderId as number),
        price: args.price,
        nonce: args.nonce,
        deadline: args.deadline,
      };
    case "LimitOrder":
      return {
        quantity: args.quantity,
        instrumentId: BigInt(args.instrumentId as number),
        price: args.price,
        bidOrAsk: args.bidOrAsk,
        nonce: args.nonce,
        deadline: args.deadline,
      };
    case "MarketOrder":
      return {
        quantity: args.quantity,
        minReceivedQuantity: args.minReceivedQuantity,
        instrumentId: BigInt(args.instrumentId as number),
        bidOrAsk: args.bidOrAsk,
        nonce: args.nonce,
        deadline: args.deadline,
      };
    case "AddInstrument":
      return {
        instrumentId: BigInt(args.instrumentId as number),
        base: args.base,
        quote: args.quote,
        baseLotExp: args.baseLotExp,
        quoteLotExp: args.quoteLotExp,
        nonce: args.nonce,
        deadline: args.deadline,
      };
    case "Deposit":
    case "Withdrawal":
      return {
        asset: args.asset,
        amount: args.amount,
        nonce: args.nonce,
        deadline: args.deadline,
      };
  }
}

async function signedMutation(params: {
  name: OrderBookMutationName;
  args: SubmittedOrderBookMutation["args"];
  signerKeyId: bigint;
  privateKey: Hex;
  address: Address;
  account: Hex;
}): Promise<SubmittedOrderBookMutation> {
  const rawSignature =
    params.name === "Initialize"
      ? "0x"
      : await signTypedData({
          privateKey: params.privateKey,
          domain: {
            name: "Exchange",
            version: "1",
            chainId: anvil.id,
            verifyingContract: params.address,
          },
          types: EIP712_TYPES,
          primaryType: params.name,
          message: messageFor(
            params.name,
            params.args as Record<string, unknown>,
          ) as never,
        });
  return {
    name: params.name,
    args: params.args,
    signature: {
      account: params.account,
      keyId: params.signerKeyId,
      rawSignature,
    },
  };
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
      args: {
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
  });
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
    args: {
      asset: BASE,
      amount: 11n,
      nonce: 0n,
      deadline: FAR_DEADLINE,
    },
  });

  await expect(
    executeOrderBookMutation(app, {
      ...signed,
      args: {
        asset: BASE,
        amount: 10n,
        nonce: 0n,
        deadline: FAR_DEADLINE,
      },
    }),
  ).rejects.toThrow(/InvalidSignature/);

  await app.stop();
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
      args: {
        instrumentId: 0,
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
      args: {
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
      args: {
        quantity: 10n,
        instrumentId: 0,
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
      args: {
        orderId: 0,
        price: 6n * Q32,
        nonce: 3n,
        deadline: FAR_DEADLINE,
      },
    }),
  );

  await app.stop();

  expect(result.id).toBeGreaterThanOrEqual(0);
});

test("db-queries fan out across per-mutation tables", async () => {
  const address = await deployExchange();
  const app = await createOrderBookFFCA(address);
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
      args: {
        instrumentId: 0,
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
      args: {
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

  // loadBlock: any per-type table referencing this block returns its metadata.
  const block = await loadBlock(db, schema, blockNumber);
  expect(block).toMatchObject({
    number: blockNumber,
    hash: depositRow.blockHash,
    timestamp: depositRow.blockTimestamp.toString(),
  });

  // loadMutationById: globally unique id resolves through the right table.
  const byId = await loadMutationById(db, schema, depositRow.id);
  expect(byId).toMatchObject({
    id: depositRow.id,
    type: "deposit",
    status: "included",
    account: maker,
    nonce: "1",
    blockNumber,
  });
  expect((byId?.payload as { asset: string; amount: string }).amount).toBe("7");

  // loadMutationByAccountNonce: looks across nonce-bearing tables.
  const byAccountNonce = await loadMutationByAccountNonce(
    db,
    schema,
    maker,
    "1",
  );
  expect(byAccountNonce?.id).toBe(depositRow.id);

  // loadMutationsByBlock: returns every persisted mutation that landed in
  // the block, ordered by mutation id.
  const inBlock = await loadMutationsByBlock(db, schema, blockNumber);
  expect(inBlock.length).toBeGreaterThanOrEqual(1);
  const typesInBlock = new Set(inBlock.map((m) => m.type));
  expect(typesInBlock.has("deposit")).toBe(true);

  // loadMutationsByAccount: most recent N mutations for this account across
  // all per-type tables, ordered by id desc.
  const recent = await loadMutationsByAccount(db, schema, maker, 10);
  expect(recent.map((m) => m.type)).toEqual([
    "deposit",
    "addInstrument",
    "initialize",
  ]);
  expect(recent.every((m) => m.account === maker)).toBe(true);

  // 404 paths.
  expect(await loadBlock(db, schema, "999999")).toBeNull();
  expect(await loadMutationById(db, schema, 999_999)).toBeNull();
  expect(await loadMutationByAccountNonce(db, schema, maker, "999")).toBeNull();

  await app.stop();
});
