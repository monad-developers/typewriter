import {
  char,
  index,
  integer,
  numeric,
  pgEnum,
  pgTable,
  primaryKey,
  serial,
  text,
  timestamp,
} from "drizzle-orm/pg-core";

const uint8 = (name: string) => numeric(name, { precision: 3, scale: 0 });
const uint16 = (name: string) => numeric(name, { precision: 5, scale: 0 });
const uint32 = (name: string) => numeric(name, { precision: 10, scale: 0 });
const uint64 = (name: string) => numeric(name, { precision: 20, scale: 0 });
const uint256 = (name: string) => numeric(name, { precision: 78, scale: 0 });
const addressCol = (name: string) => char(name, { length: 42 });

export const mutationStatusEnum = pgEnum("mutation_status", [
  "accepted",
  "proposed",
  "voted",
  "finalized",
  "verified",
]);

export const accounts = pgTable("accounts", {
  address: addressCol("address").primaryKey(),
  nonce: uint256("nonce").notNull().default("0"),
});

export const balances = pgTable(
  "balances",
  {
    account: addressCol("account")
      .notNull()
      .references(() => accounts.address),
    asset: addressCol("asset").notNull(),
    amount: uint256("amount").notNull().default("0"),
  },
  (t) => [
    primaryKey({ columns: [t.account, t.asset] }),
    index("balances_asset_idx").on(t.asset),
  ],
);

export const instruments = pgTable("instruments", {
  id: uint64("id").primaryKey(),
  base: addressCol("base").notNull(),
  baseLotExp: uint16("base_lot_exp").notNull(),
  quote: addressCol("quote").notNull(),
  quoteLotExp: uint16("quote_lot_exp").notNull(),
});

export const ticks = pgTable(
  "ticks",
  {
    instrumentId: uint64("instrument_id").notNull(),
    side: uint8("side").notNull(),
    price: uint64("price").notNull(),
    quantity: uint64("quantity").notNull().default("0"),
    remainingQuantity: uint64("remaining_quantity").notNull().default("0"),
    volume: uint32("volume").notNull().default("0"),
  },
  (t) => [primaryKey({ columns: [t.instrumentId, t.side, t.price] })],
);

export const orders = pgTable(
  "orders",
  {
    id: serial("id").primaryKey(),
    account: addressCol("account")
      .notNull()
      .references(() => accounts.address),
    orderIndex: integer("order_index").notNull(),
    quantity: uint64("quantity").notNull(),
    instrumentId: uint64("instrument_id").notNull(),
    price: uint64("price").notNull(),
    tickVolume: uint32("tick_volume").notNull(),
    side: uint8("side").notNull(),
  },
  (t) => [
    index("orders_account_idx").on(t.account),
    index("orders_instrument_side_price_idx").on(
      t.instrumentId,
      t.side,
      t.price,
    ),
  ],
);

export const bundles = pgTable("bundles", {
  id: serial("id").primaryKey(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  txHash: char("tx_hash", { length: 66 }),
  calldata: text("calldata"),
});

function signed() {
  return {
    account: addressCol("account").notNull(),
    nonce: uint256("nonce").notNull(),
    deadline: uint256("deadline").notNull(),
    signature: text("signature").notNull(),
  };
}

function mutationBase() {
  return {
    id: serial("id").primaryKey(),
    bundleId: integer("bundle_id").references(() => bundles.id),
    status: mutationStatusEnum("status").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  };
}

export const closeOrders = pgTable(
  "close_orders",
  {
    ...mutationBase(),
    ...signed(),
    orderId: uint64("order_id").notNull(),
  },
  (t) => [
    index("close_orders_account_idx").on(t.account),
    index("close_orders_bundle_id_idx").on(t.bundleId),
  ],
);

export const limitOrders = pgTable(
  "limit_orders",
  {
    ...mutationBase(),
    ...signed(),
    quantity: uint64("quantity").notNull(),
    instrumentId: uint64("instrument_id").notNull(),
    price: uint64("price").notNull(),
    bidOrAsk: uint8("bid_or_ask").notNull(),
  },
  (t) => [
    index("limit_orders_account_idx").on(t.account),
    index("limit_orders_instrument_id_idx").on(t.instrumentId),
    index("limit_orders_bundle_id_idx").on(t.bundleId),
  ],
);

export const marketOrders = pgTable(
  "market_orders",
  {
    ...mutationBase(),
    ...signed(),
    quantity: uint64("quantity").notNull(),
    minReceivedQuantity: uint64("min_received_quantity").notNull(),
    instrumentId: uint64("instrument_id").notNull(),
    bidOrAsk: uint8("bid_or_ask").notNull(),
  },
  (t) => [
    index("market_orders_account_idx").on(t.account),
    index("market_orders_instrument_id_idx").on(t.instrumentId),
    index("market_orders_bundle_id_idx").on(t.bundleId),
  ],
);

export const fills = pgTable(
  "fills",
  {
    id: serial("id").primaryKey(),
    marketOrderId: integer("market_order_id")
      .notNull()
      .references(() => marketOrders.id),
    sequence: uint8("sequence").notNull(),
    quantity: uint64("quantity").notNull(),
    price: uint64("price").notNull(),
  },
  (t) => [index("fills_market_order_id_idx").on(t.marketOrderId)],
);

export const addInstruments = pgTable(
  "add_instruments",
  {
    ...mutationBase(),
    instrumentId: uint64("instrument_id").notNull(),
    base: addressCol("base").notNull(),
    quote: addressCol("quote").notNull(),
    baseLotExp: uint16("base_lot_exp").notNull(),
    quoteLotExp: uint16("quote_lot_exp").notNull(),
  },
  (t) => [index("add_instruments_bundle_id_idx").on(t.bundleId)],
);

export const deposits = pgTable(
  "deposits",
  {
    ...mutationBase(),
    ...signed(),
    asset: addressCol("asset").notNull(),
    amount: uint256("amount").notNull(),
  },
  (t) => [
    index("deposits_account_idx").on(t.account),
    index("deposits_bundle_id_idx").on(t.bundleId),
  ],
);

export const withdrawals = pgTable(
  "withdrawals",
  {
    ...mutationBase(),
    ...signed(),
    asset: addressCol("asset").notNull(),
    amount: uint256("amount").notNull(),
  },
  (t) => [
    index("withdrawals_account_idx").on(t.account),
    index("withdrawals_bundle_id_idx").on(t.bundleId),
  ],
);
