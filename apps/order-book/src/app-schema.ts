import {
  bigint,
  char,
  integer,
  numeric,
  pgEnum,
  primaryKey,
  serial,
  smallint,
  snakeCase,
  text,
  timestamp,
} from "drizzle-orm/pg-core";

const pgTable = snakeCase.table;

const uint8 = () => smallint();
const uint16 = () => integer();
const uint32 = () => bigint({ mode: "number" });
const uint40 = () => bigint({ mode: "number" });
const uint64 = () => bigint({ mode: "bigint" });
const uint256 = () => numeric({ precision: 78, scale: 0 });
const address = () => char({ length: 42 });
const bytes32 = () => char({ length: 66 });

const mutationStatusEnum = pgEnum("mutation_status", [
  "accepted",
  "included",
  "safe",
  "finalized",
]);

const mutationColumns = () => ({
  id: integer().notNull().primaryKey(),
  bundleId: integer(),
  bundlePosition: integer(),
  blockNumber: uint256(),
  blockHash: bytes32(),
  blockTimestamp: uint256(),
  transactionHash: bytes32(),
  status: mutationStatusEnum().notNull(),
  acceptedAt: timestamp().notNull().defaultNow(),
  includedAt: timestamp(),
  safeAt: timestamp(),
  finalizedAt: timestamp(),
});

export const accounts = pgTable("accounts", {
  id: bytes32().primaryKey(),
  serial: serial().notNull(),
});

export const keys = pgTable(
  "keys",
  {
    account: bytes32()
      .notNull()
      .references(() => accounts.id),
    keyIndex: uint64().notNull(),
    expiry: uint40().notNull(),
    keyType: uint8().notNull(),
    permissions: uint16().notNull(),
    publicKey: text().notNull(),
  },
  (t) => [primaryKey({ columns: [t.account, t.keyIndex] })],
);

export const nonces = pgTable(
  "nonces",
  {
    account: bytes32()
      .notNull()
      .references(() => accounts.id),
    nonceKey: uint256().notNull(),
    sequence: uint64().notNull(),
  },
  (t) => [primaryKey({ columns: [t.account, t.nonceKey] })],
);

export const balances = pgTable(
  "balances",
  {
    account: bytes32()
      .notNull()
      .references(() => accounts.id),
    asset: address().notNull(),
    amount: uint256().notNull(),
  },
  (t) => [primaryKey({ columns: [t.account, t.asset] })],
);

export const instruments = pgTable("instruments", {
  id: uint64().primaryKey(),
  base: address().notNull(),
  baseLotExp: uint16().notNull(),
  quote: address().notNull(),
  quoteLotExp: uint16().notNull(),
});

export const ticks = pgTable(
  "ticks",
  {
    instrumentId: uint64()
      .notNull()
      .references(() => instruments.id),
    side: uint8().notNull(),
    price: uint64().notNull(),
    quantity: uint64().notNull(),
    remainingQuantity: uint64().notNull(),
    volume: uint32().notNull(),
  },
  (t) => [primaryKey({ columns: [t.instrumentId, t.side, t.price] })],
);

export const orders = pgTable(
  "orders",
  {
    orderIndex: uint64().notNull(),
    account: bytes32()
      .notNull()
      .references(() => accounts.id),
    quantity: uint64().notNull(),
    instrumentId: uint64()
      .notNull()
      .references(() => instruments.id),
    price: uint64().notNull(),
    tickVolume: uint32().notNull(),
    side: uint8().notNull(),
  },
  (t) => [primaryKey({ columns: [t.account, t.orderIndex] })],
);

const signatureColumns = {
  account: bytes32().notNull(),
  keyId: uint64().notNull(),
  rawSignature: text().notNull(),
};

export const initializes = pgTable("initializes", {
  ...mutationColumns(),
  ...signatureColumns,
  accountArg: bytes32().notNull(),
  expiry: uint40().notNull(),
  rootKeyType: uint8().notNull(),
  keyType: uint8().notNull(),
  permissions: uint16().notNull(),
  rootPublicKey: text().notNull(),
  publicKey: text().notNull(),
});

export const authorizes = pgTable("authorizes", {
  ...mutationColumns(),
  ...signatureColumns,
  accountArg: bytes32().notNull(),
  expiry: uint40().notNull(),
  keyType: uint8().notNull(),
  permissions: uint16().notNull(),
  publicKey: text().notNull(),
  nonce: uint256().notNull(),
  deadline: uint256().notNull(),
});

export const revokes = pgTable("revokes", {
  ...mutationColumns(),
  ...signatureColumns,
  accountArg: bytes32().notNull(),
  revokedKeyId: uint64().notNull(),
  nonce: uint256().notNull(),
  deadline: uint256().notNull(),
});

export const closeOrders = pgTable("close_orders", {
  ...mutationColumns(),
  ...signatureColumns,
  accountArg: bytes32().notNull(),
  orderId: uint64().notNull(),
  nonce: uint256().notNull(),
  deadline: uint256().notNull(),
});

export const changeOrders = pgTable("change_orders", {
  ...mutationColumns(),
  ...signatureColumns,
  accountArg: bytes32().notNull(),
  orderId: uint64().notNull(),
  price: uint64().notNull(),
  nonce: uint256().notNull(),
  deadline: uint256().notNull(),
});

export const limitOrders = pgTable("limit_orders", {
  ...mutationColumns(),
  ...signatureColumns,
  accountArg: bytes32().notNull(),
  quantity: uint256().notNull(),
  instrumentId: uint64().notNull(),
  price: uint64().notNull(),
  bidOrAsk: uint8().notNull(),
  nonce: uint256().notNull(),
  deadline: uint256().notNull(),
});

export const marketOrders = pgTable("market_orders", {
  ...mutationColumns(),
  ...signatureColumns,
  accountArg: bytes32().notNull(),
  quantity: uint256().notNull(),
  minReceivedQuantity: uint256().notNull(),
  instrumentId: uint64().notNull(),
  bidOrAsk: uint8().notNull(),
  nonce: uint256().notNull(),
  deadline: uint256().notNull(),
});

export const fills = pgTable("fills", {
  id: serial().primaryKey(),
  marketOrderId: integer()
    .notNull()
    .references(() => marketOrders.id),
  fillIndex: uint8().notNull(),
  quantity: uint64().notNull(),
  price: uint64().notNull(),
});

export const addInstruments = pgTable("add_instruments", {
  ...mutationColumns(),
  ...signatureColumns,
  accountArg: bytes32().notNull(),
  instrumentId: uint64().notNull(),
  base: address().notNull(),
  quote: address().notNull(),
  baseLotExp: uint16().notNull(),
  quoteLotExp: uint16().notNull(),
  nonce: uint256().notNull(),
  deadline: uint256().notNull(),
});

export const deposits = pgTable("deposits", {
  ...mutationColumns(),
  ...signatureColumns,
  accountArg: bytes32().notNull(),
  asset: address().notNull(),
  amount: uint256().notNull(),
  nonce: uint256().notNull(),
  deadline: uint256().notNull(),
});

export const withdrawals = pgTable("withdrawals", {
  ...mutationColumns(),
  ...signatureColumns,
  accountArg: bytes32().notNull(),
  asset: address().notNull(),
  amount: uint256().notNull(),
  nonce: uint256().notNull(),
  deadline: uint256().notNull(),
});

export const APP_SCHEMA = {
  accounts,
  keys,
  nonces,
  balances,
  instruments,
  ticks,
  orders,
  initializes,
  authorizes,
  revokes,
  closeOrders,
  changeOrders,
  limitOrders,
  marketOrders,
  fills,
  addInstruments,
  deposits,
  withdrawals,
};
