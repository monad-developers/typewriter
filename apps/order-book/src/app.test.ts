import { expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sql/postgres";
import { createFFCA, type FFCA } from "ffca";
import { EIP712_TYPES, EXCHANGE_ABI } from "order-book-sdk";
import { type Address, encodeAbiParameters, type Hex, keccak256 } from "viem";
import { signTypedData } from "viem/accounts";
import { anvil } from "viem/chains";
import {
  deployExchange,
  MAKER_ACCOUNT,
  MAKER_PRIVATE_KEY,
  SCHEDULER_ACCOUNT,
  TAKER_ACCOUNT,
  TAKER_PRIVATE_KEY,
  TEST_DB_CONNECTION,
  TEST_DB_URL,
  TEST_RPC_URL,
} from "../test/setup";
import {
  baseMutations,
  createKnownPriceLevels,
  loadOrderBookState,
  normalizeSignatureForContract,
  ORDER_BOOK_SEQUENCE,
  ORDER_BOOK_SIGNATURE_PARAMS,
  type OrderBookMutationName,
  persistedMutations,
  type SubmittedOrderBookMutation,
} from "./app";
import * as schema from "./app-schema";
import {
  loadBlock,
  loadMutationByAccountNonce,
  loadMutationById,
  loadMutationsByAccount,
  loadMutationsByBlock,
} from "./db-queries";
import { ALL_PERMISSIONS, type State } from "./exchange";
import { EXCHANGE_STORAGE_LAYOUT } from "./storage-layout";

const BASE: Address = "0x1111111111111111111111111111111111111111";
const QUOTE: Address = "0x2222222222222222222222222222222222222222";
const Q32 = 1n << 32n;
const FAR_DEADLINE = BigInt(Math.floor(Date.now() / 1000) + 86_400);

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
  app: FFCA;
  state: State<bigint>;
  account: Address;
  privateKey: Hex;
  contract: Address;
}): Promise<Hex> {
  const publicKey = secp256k1PublicKey(params.account);
  const id = accountId(publicKey);
  await executeOrderBookMutation(
    params.app,
    params.state,
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
  app: FFCA,
  state: State<bigint>,
  submitted: SubmittedOrderBookMutation,
) {
  return app.execute({
    ...submitted,
    signature: normalizeSignatureForContract(state, submitted.signature),
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
  const app = await createFFCA({
    address,
    domain: { name: "Exchange", version: "1" },
    abi: EXCHANGE_ABI,
    storageLayout: EXCHANGE_STORAGE_LAYOUT,
    account: SCHEDULER_ACCOUNT,
    chainId: anvil.id,
    rpcUrl: TEST_RPC_URL,
    database: { url: TEST_DB_URL, maxConnections: 4 },
    state: { initial: { accounts: {}, instruments: {} } as State<bigint> },
    signature: { params: ORDER_BOOK_SIGNATURE_PARAMS },
    sequence: ORDER_BOOK_SEQUENCE,
    mutations: baseMutations(),
  });

  const maker = await setupAccount({
    app,
    state: app.state as State<bigint>,
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
    executeOrderBookMutation(app, app.state as State<bigint>, {
      ...signed,
      args: {
        asset: BASE,
        amount: 10n,
        nonce: 0n,
        deadline: FAR_DEADLINE,
      },
    }),
  ).rejects.toThrow(/InvalidSignature/);

  const runtimeState = app.state as State<bigint>;
  expect(runtimeState.accounts[maker]!.balances[BASE]).toBeUndefined();
  expect(runtimeState.accounts[maker]!.nonces["0"]).toBeUndefined();
  await app.stop();
});

test("ffca order book persists and submits market-order flow", async () => {
  const address = await deployExchange();
  const state: State<bigint> = { accounts: {}, instruments: {} };
  const app = await createFFCA({
    address,
    domain: { name: "Exchange", version: "1" },
    abi: EXCHANGE_ABI,
    storageLayout: EXCHANGE_STORAGE_LAYOUT,
    account: SCHEDULER_ACCOUNT,
    chainId: anvil.id,
    rpcUrl: TEST_RPC_URL,
    database: { url: TEST_DB_URL, maxConnections: 4 },
    state: {
      initial: state,
      schema: schema.APP_SCHEMA,
      load: loadOrderBookState,
    },
    signature: { params: ORDER_BOOK_SIGNATURE_PARAMS },
    sequence: ORDER_BOOK_SEQUENCE,
    mutations: persistedMutations(),
  });
  const db = drizzle({
    client: TEST_DB_CONNECTION,
  });

  const maker = await setupAccount({
    app,
    state: app.state as State<bigint>,
    account: MAKER_ACCOUNT.address,
    privateKey: MAKER_PRIVATE_KEY,
    contract: address,
  });
  const taker = await setupAccount({
    app,
    state: app.state as State<bigint>,
    account: TAKER_ACCOUNT.address,
    privateKey: TAKER_PRIVATE_KEY,
    contract: address,
  });
  await waitForIncluded(db, schema.initializes, "initialize");

  await executeOrderBookMutation(
    app,
    app.state as State<bigint>,
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
    app.state as State<bigint>,
    await signedMutation({
      name: "Deposit",
      address,
      privateKey: MAKER_PRIVATE_KEY,
      signerKeyId: 1n,
      account: maker,
      args: {
        asset: BASE,
        amount: 10n,
        nonce: 1n,
        deadline: FAR_DEADLINE,
      },
    }),
  );
  await executeOrderBookMutation(
    app,
    app.state as State<bigint>,
    await signedMutation({
      name: "Deposit",
      address,
      privateKey: TAKER_PRIVATE_KEY,
      signerKeyId: 1n,
      account: taker,
      args: {
        asset: QUOTE,
        amount: 100n,
        nonce: 0n,
        deadline: FAR_DEADLINE,
      },
    }),
  );
  await executeOrderBookMutation(
    app,
    app.state as State<bigint>,
    await signedMutation({
      name: "LimitOrder",
      address,
      privateKey: MAKER_PRIVATE_KEY,
      signerKeyId: 1n,
      account: maker,
      args: {
        quantity: 10n,
        instrumentId: 0,
        price: 10n * Q32,
        bidOrAsk: 1,
        nonce: 2n,
        deadline: FAR_DEADLINE,
      },
    }),
  );
  const result = await executeOrderBookMutation(
    app,
    app.state as State<bigint>,
    await signedMutation({
      name: "MarketOrder",
      address,
      privateKey: TAKER_PRIVATE_KEY,
      signerKeyId: 1n,
      account: taker,
      args: {
        quantity: 10n,
        minReceivedQuantity: 10n,
        instrumentId: 0,
        bidOrAsk: 0,
        nonce: 1n,
        deadline: FAR_DEADLINE,
      },
    }),
  );

  expect(result.status).toBe("accepted");
  const runtimeState = app.state as State<bigint>;
  expect(runtimeState.accounts[taker]!.balances[BASE]).toBe(10n);
  expect(runtimeState.accounts[maker]!.orders[0]!.quantity).toBe(10n);
  expect(
    runtimeState.instruments[0]!.asks[Number(10n * Q32)]!.remainingQuantity,
  ).toBe(0n);

  await waitForIncluded(db, schema.marketOrders, "market order");

  const [balance] = await db
    .select()
    .from(schema.balances)
    .where(
      and(eq(schema.balances.account, taker), eq(schema.balances.asset, QUOTE)),
    );
  const [fill] = await db.select().from(schema.fills).limit(1);
  const [market] = await db.select().from(schema.marketOrders).limit(1);

  await app.stop();

  expect(balance).toMatchObject({ account: taker, asset: QUOTE, amount: "0" });
  expect(fill).toMatchObject({ quantity: 10n, price: 10n * Q32 });
  expect(market?.status).toBe("included");
});

test("ffca order book resolves market orders after persisted reload", async () => {
  const address = await deployExchange();
  const knownPriceLevels = createKnownPriceLevels();
  let app = await createFFCA({
    address,
    domain: { name: "Exchange", version: "1" },
    abi: EXCHANGE_ABI,
    storageLayout: EXCHANGE_STORAGE_LAYOUT,
    account: SCHEDULER_ACCOUNT,
    chainId: anvil.id,
    rpcUrl: TEST_RPC_URL,
    database: { url: TEST_DB_URL, maxConnections: 4 },
    state: {
      initial: { accounts: {}, instruments: {} } as State<bigint>,
      schema: schema.APP_SCHEMA,
      load: (tx) => loadOrderBookState(tx, knownPriceLevels),
    },
    signature: { params: ORDER_BOOK_SIGNATURE_PARAMS },
    sequence: ORDER_BOOK_SEQUENCE,
    mutations: persistedMutations(knownPriceLevels),
  });
  const db = drizzle({
    client: TEST_DB_CONNECTION,
  });

  const maker = await setupAccount({
    app,
    state: app.state as State<bigint>,
    account: MAKER_ACCOUNT.address,
    privateKey: MAKER_PRIVATE_KEY,
    contract: address,
  });
  const taker = await setupAccount({
    app,
    state: app.state as State<bigint>,
    account: TAKER_ACCOUNT.address,
    privateKey: TAKER_PRIVATE_KEY,
    contract: address,
  });

  await executeOrderBookMutation(
    app,
    app.state as State<bigint>,
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
    app.state as State<bigint>,
    await signedMutation({
      name: "Deposit",
      address,
      privateKey: MAKER_PRIVATE_KEY,
      signerKeyId: 1n,
      account: maker,
      args: { asset: BASE, amount: 10n, nonce: 1n, deadline: FAR_DEADLINE },
    }),
  );
  await executeOrderBookMutation(
    app,
    app.state as State<bigint>,
    await signedMutation({
      name: "Deposit",
      address,
      privateKey: TAKER_PRIVATE_KEY,
      signerKeyId: 1n,
      account: taker,
      args: { asset: QUOTE, amount: 100n, nonce: 0n, deadline: FAR_DEADLINE },
    }),
  );
  await executeOrderBookMutation(
    app,
    app.state as State<bigint>,
    await signedMutation({
      name: "LimitOrder",
      address,
      privateKey: MAKER_PRIVATE_KEY,
      signerKeyId: 1n,
      account: maker,
      args: {
        quantity: 10n,
        instrumentId: 0,
        price: 10n * Q32,
        bidOrAsk: 1,
        nonce: 2n,
        deadline: FAR_DEADLINE,
      },
    }),
  );
  await waitForIncluded(db, schema.limitOrders, "limit order");
  await app.stop();

  const reloadedPriceLevels = createKnownPriceLevels();
  app = await createFFCA({
    address,
    domain: { name: "Exchange", version: "1" },
    abi: EXCHANGE_ABI,
    storageLayout: EXCHANGE_STORAGE_LAYOUT,
    account: SCHEDULER_ACCOUNT,
    chainId: anvil.id,
    rpcUrl: TEST_RPC_URL,
    database: { url: TEST_DB_URL, maxConnections: 4 },
    state: {
      initial: { accounts: {}, instruments: {} } as State<bigint>,
      schema: schema.APP_SCHEMA,
      load: (tx) => loadOrderBookState(tx, reloadedPriceLevels),
    },
    signature: { params: ORDER_BOOK_SIGNATURE_PARAMS },
    sequence: ORDER_BOOK_SEQUENCE,
    mutations: persistedMutations(reloadedPriceLevels),
  });

  const result = await executeOrderBookMutation(
    app,
    app.state as State<bigint>,
    await signedMutation({
      name: "MarketOrder",
      address,
      privateKey: TAKER_PRIVATE_KEY,
      signerKeyId: 1n,
      account: taker,
      args: {
        quantity: 10n,
        minReceivedQuantity: 10n,
        instrumentId: 0,
        bidOrAsk: 0,
        nonce: 1n,
        deadline: FAR_DEADLINE,
      },
    }),
  );

  expect(result.status).toBe("accepted");
  expect((app.state as State<bigint>).accounts[taker]!.balances[BASE]).toBe(
    10n,
  );

  await app.stop();
});

test("ffca order book changes an unfilled order to a new price", async () => {
  const address = await deployExchange();
  const state: State<bigint> = { accounts: {}, instruments: {} };
  const app = await createFFCA({
    address,
    domain: { name: "Exchange", version: "1" },
    abi: EXCHANGE_ABI,
    storageLayout: EXCHANGE_STORAGE_LAYOUT,
    account: SCHEDULER_ACCOUNT,
    chainId: anvil.id,
    rpcUrl: TEST_RPC_URL,
    database: { url: TEST_DB_URL, maxConnections: 4 },
    state: { initial: state },
    signature: { params: ORDER_BOOK_SIGNATURE_PARAMS },
    sequence: ORDER_BOOK_SEQUENCE,
    mutations: baseMutations(),
  });

  const maker = await setupAccount({
    app,
    state: app.state as State<bigint>,
    account: MAKER_ACCOUNT.address,
    privateKey: MAKER_PRIVATE_KEY,
    contract: address,
  });
  await executeOrderBookMutation(
    app,
    app.state as State<bigint>,
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
    app.state as State<bigint>,
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
    app.state as State<bigint>,
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
    app.state as State<bigint>,
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

  expect(result.status).toBe("accepted");
  expect(state.accounts[maker]!.orders[0]!.quantity).toBe(0n);
  expect(state.accounts[maker]!.orders[1]).toMatchObject({
    quantity: 10n,
    instrumentId: 0,
    price: 6n * Q32,
    side: 0,
  });
  expect(state.instruments[0]!.bids[Number(5n * Q32)]!.quantity).toBe(0n);
  expect(state.instruments[0]!.bids[Number(6n * Q32)]!.quantity).toBe(10n);
});

test("db-queries fan out across per-mutation tables", async () => {
  const address = await deployExchange();
  const state: State<bigint> = { accounts: {}, instruments: {} };
  const app = await createFFCA({
    address,
    domain: { name: "Exchange", version: "1" },
    abi: EXCHANGE_ABI,
    storageLayout: EXCHANGE_STORAGE_LAYOUT,
    account: SCHEDULER_ACCOUNT,
    chainId: anvil.id,
    rpcUrl: TEST_RPC_URL,
    database: { url: TEST_DB_URL, maxConnections: 4 },
    state: {
      initial: state,
      schema: schema.APP_SCHEMA,
      load: loadOrderBookState,
    },
    signature: { params: ORDER_BOOK_SIGNATURE_PARAMS },
    sequence: ORDER_BOOK_SEQUENCE,
    mutations: persistedMutations(),
  });
  const db = drizzle({
    client: TEST_DB_CONNECTION,
  });

  const maker = await setupAccount({
    app,
    state: app.state as State<bigint>,
    account: MAKER_ACCOUNT.address,
    privateKey: MAKER_PRIVATE_KEY,
    contract: address,
  });
  await executeOrderBookMutation(
    app,
    app.state as State<bigint>,
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
    app.state as State<bigint>,
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

  await waitForIncluded(db, schema.deposits, "deposit");

  const [depositRow] = await db.select().from(schema.deposits).limit(1);
  expect(depositRow).toBeDefined();
  const blockNumber = depositRow!.blockNumber!;

  // loadBlock: any per-type table referencing this block returns its metadata.
  const block = await loadBlock(db, blockNumber);
  expect(block).toMatchObject({
    number: blockNumber,
    hash: depositRow!.blockHash!,
    timestamp: depositRow!.blockTimestamp!,
  });

  // loadMutationById: globally unique id resolves through the right table.
  const byId = await loadMutationById(db, depositRow!.id);
  expect(byId).toMatchObject({
    id: depositRow!.id,
    type: "deposit",
    status: "included",
    account: maker,
    nonce: "1",
    blockNumber,
  });
  expect((byId?.payload as { asset: string; amount: string }).amount).toBe("7");

  // loadMutationByAccountNonce: looks across nonce-bearing tables.
  const byAccountNonce = await loadMutationByAccountNonce(db, maker, "1");
  expect(byAccountNonce?.id).toBe(depositRow!.id);

  // loadMutationsByBlock: returns every persisted mutation that landed in
  // the block, ordered by (bundleId, bundlePosition).
  const inBlock = await loadMutationsByBlock(db, blockNumber);
  expect(inBlock.length).toBeGreaterThanOrEqual(1);
  const typesInBlock = new Set(inBlock.map((m) => m.type));
  expect(typesInBlock.has("deposit")).toBe(true);

  // loadMutationsByAccount: most recent N mutations for this account across
  // all per-type tables, ordered by id desc.
  const recent = await loadMutationsByAccount(db, maker, 10);
  expect(recent.map((m) => m.type)).toEqual([
    "deposit",
    "addInstrument",
    "initialize",
  ]);
  expect(recent.every((m) => m.account === maker)).toBe(true);

  // 404 paths.
  expect(await loadBlock(db, "999999")).toBeNull();
  expect(await loadMutationById(db, 999_999)).toBeNull();
  expect(await loadMutationByAccountNonce(db, maker, "999")).toBeNull();

  await app.stop();
});
