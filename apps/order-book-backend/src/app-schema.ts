import { relations } from "drizzle-orm";
import {
  bigint,
  char,
  index,
  integer,
  numeric,
  pgEnum,
  pgTable,
  primaryKey,
  serial,
  smallint,
  text,
  timestamp,
} from "drizzle-orm/pg-core";

const uint8 = () => smallint();
const uint16 = () => integer();
const uint32 = () => bigint({ mode: "number" });
const uint40 = () => bigint({ mode: "number" });
const uint64 = () => bigint({ mode: "bigint" });
const uint256 = () => numeric({ precision: 78, scale: 0 });
const address = () => char({ length: 42 });
const bytes32 = () => char({ length: 66 });

export const mutationEnum = pgEnum("mutation", [
  "initialize",
  "authorize",
  "revoke",
  "closeOrder",
  "limitOrder",
  "marketOrder",
  "addInstrument",
  "deposit",
  "withdrawal",
]);

export const mutationStatusEnum = pgEnum("mutation_status", [
  "pending",
  "accepted",
  "proposed",
  "voted",
  "finalized",
  "verified",
]);

export const bundleStatusEnum = pgEnum("bundle_status", [
  "accepted",
  "proposed",
  "voted",
  "finalized",
  "verified",
]);

export const accounts = pgTable("accounts", {
  id: bytes32().primaryKey(),
  serial: serial().notNull(),
});

export const accountsRelations = relations(accounts, ({ many }) => ({
  keys: many(keys),
  nonces: many(nonces),
  balances: many(balances),
  orders: many(orders),
  mutations: many(mutations),
}));

export const keys = pgTable(
  "keys",
  {
    account: bytes32()
      .notNull()
      .references(() => accounts.id),
    keyIndex: uint64().notNull(),
    expiry: uint40().notNull(),
    keyType: uint8().notNull(),
    permissions: uint8().notNull(),
    publicKey: text().notNull(),
  },
  (t) => [primaryKey({ columns: [t.account, t.keyIndex] })],
);

export const keysRelations = relations(keys, ({ one }) => ({
  accountRef: one(accounts, {
    fields: [keys.account],
    references: [accounts.id],
  }),
}));

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

export const noncesRelations = relations(nonces, ({ one }) => ({
  accountRef: one(accounts, {
    fields: [nonces.account],
    references: [accounts.id],
  }),
}));

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

export const balancesRelations = relations(balances, ({ one }) => ({
  accountRef: one(accounts, {
    fields: [balances.account],
    references: [accounts.id],
  }),
}));

export const instruments = pgTable("instruments", {
  id: uint64().primaryKey(),
  base: address().notNull(),
  baseLotExp: uint16().notNull(),
  quote: address().notNull(),
  quoteLotExp: uint16().notNull(),
});

export const instrumentsRelations = relations(instruments, ({ many }) => ({
  ticks: many(ticks),
  orders: many(orders),
  limitOrders: many(limitOrders),
  marketOrders: many(marketOrders),
  addInstruments: many(addInstruments),
}));

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

export const ticksRelations = relations(ticks, ({ one }) => ({
  instrument: one(instruments, {
    fields: [ticks.instrumentId],
    references: [instruments.id],
  }),
}));

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

export const ordersRelations = relations(orders, ({ one }) => ({
  accountRef: one(accounts, {
    fields: [orders.account],
    references: [accounts.id],
  }),
  instrument: one(instruments, {
    fields: [orders.instrumentId],
    references: [instruments.id],
  }),
}));

export const blocks = pgTable("blocks", {
  number: uint256().primaryKey(),
  hash: char({ length: 66 }).notNull(),
  timestamp: uint256().notNull(),
});

export const blocksRelations = relations(blocks, ({ many }) => ({
  bundles: many(bundles),
}));

export const bundles = pgTable(
  "bundles",
  {
    id: serial().primaryKey(),
    blockNumber: uint256().references(() => blocks.number),
    status: bundleStatusEnum().notNull().default("accepted"),
    transactionHash: char({ length: 66 }),
    acceptedAt: timestamp().notNull(),
    proposedAt: timestamp(),
    votedAt: timestamp(),
    finalizedAt: timestamp(),
    verifiedAt: timestamp(),
  },
  (t) => [index().on(t.blockNumber)],
);

export const bundlesRelations = relations(bundles, ({ one, many }) => ({
  block: one(blocks, {
    fields: [bundles.blockNumber],
    references: [blocks.number],
  }),
  mutations: many(mutations),
}));

export const mutations = pgTable(
  "mutations",
  {
    id: serial().primaryKey(),
    bundleId: integer().references(() => bundles.id),
    bundlePosition: integer(),
    blockNumber: uint256().references(() => blocks.number),
    status: mutationStatusEnum().notNull(),
    account: bytes32().notNull(),
    keyIndex: uint64(),
    nonce: uint256(),
    deadline: uint256().notNull(),
    rawSignature: text().notNull(),
    type: mutationEnum().notNull(),
    calldata: text(),
    pendingAt: timestamp().notNull(),
    acceptedAt: timestamp(),
    proposedAt: timestamp(),
    votedAt: timestamp(),
    finalizedAt: timestamp(),
    verifiedAt: timestamp(),
  },
  (t) => [
    index().on(t.bundleId, t.bundlePosition),
    index().on(t.blockNumber),
    index().on(t.account, t.id.desc()),
    index().on(t.account, t.nonce),
    // FK (account, keyIndex) -> keys disabled: blocks recoverState's
    // wipe-and-replay because deleting keys while surviving non-accepted
    // mutations reference them violates the FK. Drizzle 0.45 can't declare
    // DEFERRABLE FKs.
  ],
);

export const mutationsRelations = relations(mutations, ({ one }) => ({
  bundle: one(bundles, {
    fields: [mutations.bundleId],
    references: [bundles.id],
  }),
  block: one(blocks, {
    fields: [mutations.blockNumber],
    references: [blocks.number],
  }),
  accountRef: one(accounts, {
    fields: [mutations.account],
    references: [accounts.id],
  }),
  initialize: one(initializes, {
    fields: [mutations.id],
    references: [initializes.id],
  }),
  authorize: one(authorizes, {
    fields: [mutations.id],
    references: [authorizes.id],
  }),
  revoke: one(revokes, {
    fields: [mutations.id],
    references: [revokes.id],
  }),
  closeOrder: one(closeOrders, {
    fields: [mutations.id],
    references: [closeOrders.id],
  }),
  limitOrder: one(limitOrders, {
    fields: [mutations.id],
    references: [limitOrders.id],
  }),
  marketOrder: one(marketOrders, {
    fields: [mutations.id],
    references: [marketOrders.id],
  }),
  addInstrument: one(addInstruments, {
    fields: [mutations.id],
    references: [addInstruments.id],
  }),
  deposit: one(deposits, {
    fields: [mutations.id],
    references: [deposits.id],
  }),
  withdrawal: one(withdrawals, {
    fields: [mutations.id],
    references: [withdrawals.id],
  }),
}));

export const initializes = pgTable("initializes", {
  id: integer()
    .primaryKey()
    .references(() => mutations.id),
  expiry: uint40().notNull(),
  rootKeyType: uint8().notNull(),
  keyType: uint8().notNull(),
  permissions: uint8().notNull(),
  rootPublicKey: text().notNull(),
  publicKey: text().notNull(),
});

export const initializesRelations = relations(initializes, ({ one }) => ({
  mutation: one(mutations, {
    fields: [initializes.id],
    references: [mutations.id],
  }),
}));

export const authorizes = pgTable("authorizes", {
  id: integer()
    .primaryKey()
    .references(() => mutations.id),
  expiry: uint40().notNull(),
  keyType: uint8().notNull(),
  permissions: uint8().notNull(),
  publicKey: text().notNull(),
});

export const authorizesRelations = relations(authorizes, ({ one }) => ({
  mutation: one(mutations, {
    fields: [authorizes.id],
    references: [mutations.id],
  }),
}));

export const revokes = pgTable("revokes", {
  id: integer()
    .primaryKey()
    .references(() => mutations.id),
  revokedKeyId: uint64().notNull(),
});

export const revokesRelations = relations(revokes, ({ one }) => ({
  mutation: one(mutations, {
    fields: [revokes.id],
    references: [mutations.id],
  }),
}));

export const closeOrders = pgTable("close_orders", {
  id: integer()
    .primaryKey()
    .references(() => mutations.id),
  orderId: uint64().notNull(),
});

export const closeOrdersRelations = relations(closeOrders, ({ one }) => ({
  mutation: one(mutations, {
    fields: [closeOrders.id],
    references: [mutations.id],
  }),
}));

export const limitOrders = pgTable(
  "limit_orders",
  {
    id: integer()
      .primaryKey()
      .references(() => mutations.id),
    quantity: uint256().notNull(),
    instrumentId: uint64().notNull(),
    price: uint64().notNull(),
    bidOrAsk: uint8().notNull(),
  },
  (t) => [index().on(t.instrumentId)],
);

export const limitOrdersRelations = relations(limitOrders, ({ one }) => ({
  mutation: one(mutations, {
    fields: [limitOrders.id],
    references: [mutations.id],
  }),
  instrument: one(instruments, {
    fields: [limitOrders.instrumentId],
    references: [instruments.id],
  }),
}));

export const marketOrders = pgTable(
  "market_orders",
  {
    id: integer()
      .primaryKey()
      .references(() => mutations.id),
    quantity: uint256().notNull(),
    minReceivedQuantity: uint256().notNull(),
    instrumentId: uint64().notNull(),
    bidOrAsk: uint8().notNull(),
  },
  (t) => [index().on(t.instrumentId)],
);

export const marketOrdersRelations = relations(
  marketOrders,
  ({ one, many }) => ({
    mutation: one(mutations, {
      fields: [marketOrders.id],
      references: [mutations.id],
    }),
    instrument: one(instruments, {
      fields: [marketOrders.instrumentId],
      references: [instruments.id],
    }),
    fills: many(fills),
  }),
);

export const fills = pgTable(
  "fills",
  {
    id: serial().primaryKey(),
    marketOrderId: integer()
      .notNull()
      .references(() => marketOrders.id),
    fillIndex: uint8().notNull(),
    quantity: uint64().notNull(),
    price: uint64().notNull(),
  },
  (t) => [index().on(t.marketOrderId)],
);

export const fillsRelations = relations(fills, ({ one }) => ({
  marketOrder: one(marketOrders, {
    fields: [fills.marketOrderId],
    references: [marketOrders.id],
  }),
}));

export const addInstruments = pgTable("add_instruments", {
  id: integer()
    .primaryKey()
    .references(() => mutations.id),
  instrumentId: uint64().notNull(),
  base: address().notNull(),
  quote: address().notNull(),
  baseLotExp: uint16().notNull(),
  quoteLotExp: uint16().notNull(),
});

export const addInstrumentsRelations = relations(addInstruments, ({ one }) => ({
  mutation: one(mutations, {
    fields: [addInstruments.id],
    references: [mutations.id],
  }),
  instrument: one(instruments, {
    fields: [addInstruments.instrumentId],
    references: [instruments.id],
  }),
}));

export const deposits = pgTable("deposits", {
  id: integer()
    .primaryKey()
    .references(() => mutations.id),
  asset: address().notNull(),
  amount: uint256().notNull(),
});

export const depositsRelations = relations(deposits, ({ one }) => ({
  mutation: one(mutations, {
    fields: [deposits.id],
    references: [mutations.id],
  }),
}));

export const withdrawals = pgTable("withdrawals", {
  id: integer()
    .primaryKey()
    .references(() => mutations.id),
  asset: address().notNull(),
  amount: uint256().notNull(),
});

export const withdrawalsRelations = relations(withdrawals, ({ one }) => ({
  mutation: one(mutations, {
    fields: [withdrawals.id],
    references: [mutations.id],
  }),
}));
