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
} from "drizzle-orm/pg-core";

const uint8 = () => smallint();
const uint16 = () => integer();
const uint32 = () => bigint({ mode: "number" });
const uint64 = () => bigint({ mode: "bigint" });
const uint256 = () => numeric({ precision: 78, scale: 0 });
const address = () => char({ length: 42 });

export const mutationStatusEnum = pgEnum("mutation_status", [
  "accepted",
  "proposed",
  "voted",
  "finalized",
  "verified",
]);

export const accounts = pgTable("accounts", {
  address: address().primaryKey(),
  nonce: uint256().notNull().default("0"),
});

export const accountsRelations = relations(accounts, ({ many }) => ({
  balances: many(balances),
  orders: many(orders),
  closeOrders: many(closeOrders),
  limitOrders: many(limitOrders),
  marketOrders: many(marketOrders),
  deposits: many(deposits),
  withdrawals: many(withdrawals),
}));

export const balances = pgTable(
  "balances",
  {
    account: address()
      .notNull()
      .references(() => accounts.address),
    asset: address().notNull(),
    amount: uint256().notNull(),
  },
  (t) => [primaryKey({ columns: [t.account, t.asset] })],
);

export const balancesRelations = relations(balances, ({ one }) => ({
  accountRef: one(accounts, {
    fields: [balances.account],
    references: [accounts.address],
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
    account: address()
      .notNull()
      .references(() => accounts.address),
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
    references: [accounts.address],
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

export const bundles = pgTable("bundles", {
  id: serial().primaryKey(),
  blockNumber: uint256().references(() => blocks.number),
  transactionHash: char({ length: 66 }),
});

export const bundlesRelations = relations(bundles, ({ one, many }) => ({
  block: one(blocks, {
    fields: [bundles.blockNumber],
    references: [blocks.number],
  }),
  closeOrders: many(closeOrders),
  limitOrders: many(limitOrders),
  marketOrders: many(marketOrders),
  addInstruments: many(addInstruments),
  deposits: many(deposits),
  withdrawals: many(withdrawals),
}));

function signed() {
  return {
    account: address().notNull(),
    nonce: uint256().notNull(),
    deadline: uint256().notNull(),
    signature: text().notNull(),
  };
}

function mutationBase() {
  return {
    id: serial().primaryKey(),
    bundleId: integer().references(() => bundles.id),
    status: mutationStatusEnum().notNull(),
  };
}

export const closeOrders = pgTable(
  "close_orders",
  {
    ...mutationBase(),
    ...signed(),
    orderId: uint64().notNull(),
  },
  (t) => [index().on(t.account), index().on(t.bundleId)],
);

export const closeOrdersRelations = relations(closeOrders, ({ one }) => ({
  bundle: one(bundles, {
    fields: [closeOrders.bundleId],
    references: [bundles.id],
  }),
  accountRef: one(accounts, {
    fields: [closeOrders.account],
    references: [accounts.address],
  }),
}));

export const limitOrders = pgTable(
  "limit_orders",
  {
    ...mutationBase(),
    ...signed(),
    quantity: uint64().notNull(),
    instrumentId: uint64().notNull(),
    price: uint64().notNull(),
    bidOrAsk: uint8().notNull(),
  },
  (t) => [
    index().on(t.account),
    index().on(t.instrumentId),
    index().on(t.bundleId),
  ],
);

export const limitOrdersRelations = relations(limitOrders, ({ one }) => ({
  bundle: one(bundles, {
    fields: [limitOrders.bundleId],
    references: [bundles.id],
  }),
  accountRef: one(accounts, {
    fields: [limitOrders.account],
    references: [accounts.address],
  }),
  instrument: one(instruments, {
    fields: [limitOrders.instrumentId],
    references: [instruments.id],
  }),
}));

export const marketOrders = pgTable(
  "market_orders",
  {
    ...mutationBase(),
    ...signed(),
    quantity: uint64().notNull(),
    minReceivedQuantity: uint64().notNull(),
    instrumentId: uint64().notNull(),
    bidOrAsk: uint8().notNull(),
  },
  (t) => [
    index().on(t.account),
    index().on(t.instrumentId),
    index().on(t.bundleId),
  ],
);

export const marketOrdersRelations = relations(
  marketOrders,
  ({ one, many }) => ({
    bundle: one(bundles, {
      fields: [marketOrders.bundleId],
      references: [bundles.id],
    }),
    accountRef: one(accounts, {
      fields: [marketOrders.account],
      references: [accounts.address],
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

export const addInstruments = pgTable(
  "add_instruments",
  {
    ...mutationBase(),
    instrumentId: uint64().notNull(),
    base: address().notNull(),
    quote: address().notNull(),
    baseLotExp: uint16().notNull(),
    quoteLotExp: uint16().notNull(),
  },
  (t) => [index().on(t.bundleId)],
);

export const addInstrumentsRelations = relations(addInstruments, ({ one }) => ({
  bundle: one(bundles, {
    fields: [addInstruments.bundleId],
    references: [bundles.id],
  }),
  instrument: one(instruments, {
    fields: [addInstruments.instrumentId],
    references: [instruments.id],
  }),
}));

export const deposits = pgTable(
  "deposits",
  {
    ...mutationBase(),
    ...signed(),
    asset: address().notNull(),
    amount: uint256().notNull(),
  },
  (t) => [index().on(t.account), index().on(t.bundleId)],
);

export const depositsRelations = relations(deposits, ({ one }) => ({
  bundle: one(bundles, {
    fields: [deposits.bundleId],
    references: [bundles.id],
  }),
  accountRef: one(accounts, {
    fields: [deposits.account],
    references: [accounts.address],
  }),
}));

export const withdrawals = pgTable(
  "withdrawals",
  {
    ...mutationBase(),
    ...signed(),
    asset: address().notNull(),
    amount: uint256().notNull(),
  },
  (t) => [index().on(t.account), index().on(t.bundleId)],
);

export const withdrawalsRelations = relations(withdrawals, ({ one }) => ({
  bundle: one(bundles, {
    fields: [withdrawals.bundleId],
    references: [bundles.id],
  }),
  accountRef: one(accounts, {
    fields: [withdrawals.account],
    references: [accounts.address],
  }),
}));
