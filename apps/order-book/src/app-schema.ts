import {
  bigint,
  char,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  smallint,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import type { Hex } from "viem";

const schemaSymbol = Symbol.for("drizzle:Schema");

type SchemaMutable = Record<typeof schemaSymbol, string | undefined>;

const uint8 = (name?: string) =>
  name === undefined ? smallint() : smallint(name);
const uint16 = (name?: string) =>
  name === undefined ? integer() : integer(name);
const uint40 = (name?: string) =>
  name === undefined
    ? bigint({ mode: "bigint" })
    : bigint(name, { mode: "bigint" });
const uint64 = (name?: string) =>
  name === undefined
    ? numeric({ precision: 78, scale: 0 })
    : numeric(name, { precision: 78, scale: 0 });
const uint256 = (name?: string) =>
  name === undefined
    ? numeric({ precision: 78, scale: 0 })
    : numeric(name, { precision: 78, scale: 0 });
const address = (name?: string) =>
  (name === undefined
    ? char({ length: 42 })
    : char(name, { length: 42 })
  ).$type<Hex>();
const bytes = (name?: string) =>
  (name === undefined ? text() : text(name)).$type<Hex>();
const bytes32 = (name?: string) =>
  (name === undefined
    ? char({ length: 66 })
    : char(name, { length: 66 })
  ).$type<Hex>();

export const mutationStatusEnum = pgEnum("mutation_status", [
  "accepted",
  "included",
  "safe",
  "finalized",
]);

const mutationColumns = () => ({
  id: integer().notNull().primaryKey(),
  bundleId: integer("bundleId").notNull(),
  bundlePosition: integer("bundlePosition").notNull(),
  blockNumber: uint256("blockNumber"),
  blockHash: bytes32("blockHash"),
  blockTimestamp: uint256("blockTimestamp"),
  transactionHash: bytes32("transactionHash"),
  status: mutationStatusEnum().notNull(),
  acceptedAt: timestamp("acceptedAt").notNull().defaultNow(),
  includedAt: timestamp("includedAt"),
  safeAt: timestamp("safeAt"),
  finalizedAt: timestamp("finalizedAt"),
});

const signatureColumns = () => ({
  signatureAccount: bytes32("signature_account").notNull(),
  signatureKeyId: uint64("signature_keyId").notNull(),
  signatureRawSignature: bytes("signature_rawSignature").notNull(),
});

export const initializes = pgTable("initialize_mutations", {
  ...mutationColumns(),
  account: bytes32().notNull(),
  expiry: uint40().notNull(),
  rootKeyType: uint8("rootKeyType").notNull(),
  keyType: uint8("keyType").notNull(),
  permissions: uint16().notNull(),
  rootPublicKey: bytes("rootPublicKey").notNull(),
  publicKey: bytes("publicKey").notNull(),
  ...signatureColumns(),
});

export const authorizes = pgTable("authorize_mutations", {
  ...mutationColumns(),
  account: bytes32().notNull(),
  expiry: uint40().notNull(),
  keyType: uint8("keyType").notNull(),
  permissions: uint16().notNull(),
  publicKey: bytes("publicKey").notNull(),
  nonce: uint256().notNull(),
  deadline: uint256().notNull(),
  ...signatureColumns(),
});

export const revokes = pgTable("revoke_mutations", {
  ...mutationColumns(),
  account: bytes32().notNull(),
  keyId: uint64("keyId").notNull(),
  nonce: uint256().notNull(),
  deadline: uint256().notNull(),
  ...signatureColumns(),
});

export const closeOrders = pgTable("closeorder_mutations", {
  ...mutationColumns(),
  orderId: uint64("orderId").notNull(),
  nonce: uint256().notNull(),
  deadline: uint256().notNull(),
  ...signatureColumns(),
});

export const changeOrders = pgTable("changeorder_mutations", {
  ...mutationColumns(),
  orderId: uint64("orderId").notNull(),
  price: uint64().notNull(),
  nonce: uint256().notNull(),
  deadline: uint256().notNull(),
  ...signatureColumns(),
});

export const limitOrders = pgTable("limitorder_mutations", {
  ...mutationColumns(),
  quantity: uint256().notNull(),
  instrumentId: uint64("instrumentId").notNull(),
  price: uint64().notNull(),
  bidOrAsk: uint8("bidOrAsk").notNull(),
  nonce: uint256().notNull(),
  deadline: uint256().notNull(),
  ...signatureColumns(),
});

export const marketOrders = pgTable("marketorder_mutations", {
  ...mutationColumns(),
  quantity: uint256().notNull(),
  minReceivedQuantity: uint256("minReceivedQuantity").notNull(),
  instrumentId: uint64("instrumentId").notNull(),
  bidOrAsk: uint8("bidOrAsk").notNull(),
  nonce: uint256().notNull(),
  deadline: uint256().notNull(),
  resolutionFills:
    jsonb("resolution_fills").$type<{ quantity: string; price: string }[]>(),
  ...signatureColumns(),
});

export const addInstruments = pgTable("addinstrument_mutations", {
  ...mutationColumns(),
  instrumentId: uint64("instrumentId").notNull(),
  base: address().notNull(),
  quote: address().notNull(),
  baseLotExp: uint8("baseLotExp").notNull(),
  quoteLotExp: uint8("quoteLotExp").notNull(),
  nonce: uint256().notNull(),
  deadline: uint256().notNull(),
  ...signatureColumns(),
});

export const deposits = pgTable("deposit_mutations", {
  ...mutationColumns(),
  asset: address().notNull(),
  amount: uint256().notNull(),
  nonce: uint256().notNull(),
  deadline: uint256().notNull(),
  ...signatureColumns(),
});

export const withdrawals = pgTable("withdrawal_mutations", {
  ...mutationColumns(),
  asset: address().notNull(),
  amount: uint256().notNull(),
  nonce: uint256().notNull(),
  deadline: uint256().notNull(),
  ...signatureColumns(),
});

export const APP_QUERY_SCHEMA = {
  initializes,
  authorizes,
  revokes,
  closeOrders,
  changeOrders,
  limitOrders,
  marketOrders,
  addInstruments,
  deposits,
  withdrawals,
};

export function deploymentSchemaName(chainId: number, address: Hex): string {
  return `ffca_${chainId}_${address.toLowerCase()}`;
}

export function applyDeploymentSchema(chainId: number, address: Hex): void {
  const schemaName = deploymentSchemaName(chainId, address);
  (mutationStatusEnum as unknown as { schema: string | undefined }).schema =
    schemaName;
  for (const table of Object.values(APP_QUERY_SCHEMA)) {
    (table as typeof table & SchemaMutable)[schemaSymbol] = schemaName;
  }
}
