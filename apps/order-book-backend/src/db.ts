import { eq } from "drizzle-orm";
import type { BunSQLDatabase } from "drizzle-orm/bun-sql";
import { MutationType } from "./exchange";
import type { MutationEvent, RuntimeHandle } from "./runtime";
import * as schema from "./schema";

type DB = BunSQLDatabase<typeof schema>;
type DBStatus = "accepted" | "proposed" | "voted" | "finalized" | "verified";

export function dbPlugin(handle: RuntimeHandle, db: DB) {
  handle.on("block", async (block) => {
    await db
      .insert(schema.blocks)
      .values({
        number: block.number.toString(),
        hash: block.hash,
        timestamp: block.timestamp.toString(),
      })
      .onConflictDoNothing();
  });

  handle.on("bundle", async (bundle, status) => {
    if (status === "accepted") {
      await db.insert(schema.bundles).values({ id: bundle.id });
      for (const m of bundle.mutations) {
        await insertMutation(db, m, bundle.id);
      }
    } else {
      for (const m of bundle.mutations) {
        await updateStatus(db, m.type, m.id, status);
      }
    }
  });
}

async function insertMutation(db: DB, m: MutationEvent, bundleId: number) {
  const base = { id: m.id, bundleId, status: "accepted" as DBStatus };

  switch (m.type) {
    case MutationType.Initialize:
      await db.insert(schema.initializes).values({
        ...base,
        account: m.account,
        keyId: BigInt(m.keyId),
        nonce: m.nonce.toString(),
        deadline: m.deadline.toString(),
        rawSignature: m.rawSignature,
        expiry: m.mutation.expiry,
        rootKeyType: m.mutation.rootKeyType,
        keyType: m.mutation.keyType,
        permissions: m.mutation.permissions,
        rootPublicKey: m.mutation.rootPublicKey,
        publicKey: m.mutation.publicKey,
      });
      break;
    case MutationType.Authorize:
      await db.insert(schema.authorizes).values({
        ...base,
        account: m.account,
        keyId: BigInt(m.keyId),
        nonce: m.nonce.toString(),
        deadline: m.deadline.toString(),
        rawSignature: m.rawSignature,
        expiry: m.mutation.expiry,
        keyType: m.mutation.keyType,
        permissions: m.mutation.permissions,
        publicKey: m.mutation.publicKey,
      });
      break;
    case MutationType.Revoke:
      await db.insert(schema.revokes).values({
        ...base,
        account: m.account,
        keyId: BigInt(m.keyId),
        nonce: m.nonce.toString(),
        deadline: m.deadline.toString(),
        rawSignature: m.rawSignature,
        revokedKeyId: BigInt(m.mutation.keyId),
      });
      break;
    case MutationType.CloseOrder:
      await db.insert(schema.closeOrders).values({
        ...base,
        account: m.account,
        keyId: BigInt(m.keyId),
        nonce: m.nonce.toString(),
        deadline: m.deadline.toString(),
        rawSignature: m.rawSignature,
        orderId: BigInt(m.mutation.orderId),
      });
      break;
    case MutationType.LimitOrder:
      await db.insert(schema.limitOrders).values({
        ...base,
        account: m.account,
        keyId: BigInt(m.keyId),
        nonce: m.nonce.toString(),
        deadline: m.deadline.toString(),
        rawSignature: m.rawSignature,
        quantity: m.mutation.quantity,
        instrumentId: BigInt(m.mutation.instrumentId),
        price: m.mutation.price,
        bidOrAsk: m.mutation.bidOrAsk,
      });
      break;
    case MutationType.MarketOrder:
      await db.insert(schema.marketOrders).values({
        ...base,
        account: m.account,
        keyId: BigInt(m.keyId),
        nonce: m.nonce.toString(),
        deadline: m.deadline.toString(),
        rawSignature: m.rawSignature,
        quantity: m.mutation.quantity,
        minReceivedQuantity: m.mutation.minReceivedQuantity,
        instrumentId: BigInt(m.mutation.instrumentId),
        bidOrAsk: m.mutation.bidOrAsk,
      });
      for (let i = 0; i < m.resolution.fills.length; i++) {
        const fill = m.resolution.fills[i]!;
        await db.insert(schema.fills).values({
          marketOrderId: m.id,
          fillIndex: i,
          quantity: fill.quantity,
          price: fill.price,
        });
      }
      break;
    case MutationType.AddInstrument:
      await db.insert(schema.addInstruments).values({
        ...base,
        instrumentId: BigInt(m.mutation.instrumentId),
        base: m.mutation.base,
        quote: m.mutation.quote,
        baseLotExp: m.mutation.baseLotExp,
        quoteLotExp: m.mutation.quoteLotExp,
      });
      break;
    case MutationType.Deposit:
      await db.insert(schema.deposits).values({
        ...base,
        account: m.account,
        keyId: BigInt(m.keyId),
        nonce: m.nonce.toString(),
        deadline: m.deadline.toString(),
        rawSignature: m.rawSignature,
        asset: m.mutation.asset,
        amount: m.mutation.amount.toString(),
      });
      break;
    case MutationType.Withdrawal:
      await db.insert(schema.withdrawals).values({
        ...base,
        account: m.account,
        keyId: BigInt(m.keyId),
        nonce: m.nonce.toString(),
        deadline: m.deadline.toString(),
        rawSignature: m.rawSignature,
        asset: m.mutation.asset,
        amount: m.mutation.amount.toString(),
      });
      break;
  }
}

async function updateStatus(
  db: DB,
  type: MutationType,
  id: number,
  status: string,
) {
  const s = status as DBStatus;
  switch (type) {
    case MutationType.Initialize:
      await db
        .update(schema.initializes)
        .set({ status: s })
        .where(eq(schema.initializes.id, id));
      break;
    case MutationType.Authorize:
      await db
        .update(schema.authorizes)
        .set({ status: s })
        .where(eq(schema.authorizes.id, id));
      break;
    case MutationType.Revoke:
      await db
        .update(schema.revokes)
        .set({ status: s })
        .where(eq(schema.revokes.id, id));
      break;
    case MutationType.CloseOrder:
      await db
        .update(schema.closeOrders)
        .set({ status: s })
        .where(eq(schema.closeOrders.id, id));
      break;
    case MutationType.LimitOrder:
      await db
        .update(schema.limitOrders)
        .set({ status: s })
        .where(eq(schema.limitOrders.id, id));
      break;
    case MutationType.MarketOrder:
      await db
        .update(schema.marketOrders)
        .set({ status: s })
        .where(eq(schema.marketOrders.id, id));
      break;
    case MutationType.AddInstrument:
      await db
        .update(schema.addInstruments)
        .set({ status: s })
        .where(eq(schema.addInstruments.id, id));
      break;
    case MutationType.Deposit:
      await db
        .update(schema.deposits)
        .set({ status: s })
        .where(eq(schema.deposits.id, id));
      break;
    case MutationType.Withdrawal:
      await db
        .update(schema.withdrawals)
        .set({ status: s })
        .where(eq(schema.withdrawals.id, id));
      break;
  }
}
