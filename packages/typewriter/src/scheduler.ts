import { Effect } from "effect";
import { type Address, Hex } from "ox";
import {
  createStorageView,
  type StorageLayout,
  type StorageView,
} from "storage-layout";
import { encodeSecp256k1PublicKey } from "./encoding";
import type { RpcError } from "./rpc";
import { KeyType } from "./typewriter-constants";

/** A scheduler credential, as the storage view reads it. */
export type StoredSchedulerCredential = {
  expiration: number;
  keyType: number;
  role: number;
  publicKey: Hex.Hex;
};

/** The credentials of `struct Scheduler`, as the storage view reads them. */
type StoredScheduler = {
  credentials: { length: number; [index: number]: StoredSchedulerCredential };
};

/** The scheduler's storage variable of a storage view. */
export const schedulerOf = (view: StorageView<StorageLayout, false>) =>
  // biome-ignore lint/complexity/useLiteralKeys: generic storage layouts expose root variables through an index signature.
  view["scheduler"] as unknown as StoredScheduler;

/** Every scheduler credential, removed ones included, by ID. */
export function readSchedulerCredentials(
  scheduler: StoredScheduler,
): StoredSchedulerCredential[] {
  const { credentials } = scheduler;
  return Array.from({ length: credentials.length }, (_, id) => {
    const { expiration, keyType, role, publicKey } = credentials[id]!;
    return { expiration, keyType, role, publicKey };
  });
}

const normalizeSlot = (slot: string) =>
  Hex.padLeft(slot.toLowerCase() as Hex.Hex, 32);

/**
 * Adds to `storage` the slots of the scheduler's credentials it lacks, read
 * from the chain with `readSlots`: the only scheduler state `execute` reads.
 * The constructor and the scheduler's own functions write them, never an
 * execution, so revm has them only from here. Each round reads what the
 * slots known so far point to: the credentials' count, then each credential,
 * then each long public key.
 */
export function seedScheduler(
  layout: StorageLayout,
  storage: { [slot: Hex.Hex]: Hex.Hex },
  preimages: Set<Hex.Hex>,
  readSlots: (slots: Hex.Hex[]) => Effect.Effect<Hex.Hex[], RpcError>,
): Effect.Effect<void, RpcError> {
  return Effect.gen(function* () {
    const known = new Map(
      Object.entries(storage).map(([slot, value]) => [
        normalizeSlot(slot),
        value as Hex.Hex,
      ]),
    );
    for (;;) {
      const missing = new Set<Hex.Hex>();
      const scheduler = schedulerOf(
        createStorageView(
          layout,
          (slots) =>
            slots.map((slot) => {
              const value = known.get(normalizeSlot(slot));
              if (value !== undefined) return value;
              missing.add(slot);
              return Hex.fromNumber(0, { size: 32 });
            }),
          preimages,
        ),
      );
      readSchedulerCredentials(scheduler);
      if (missing.size === 0) return;
      const slots = [...missing];
      const values = yield* readSlots(slots);
      for (const [i, slot] of slots.entries()) {
        known.set(normalizeSlot(slot), values[i]!);
        storage[slot] = values[i]!;
      }
    }
  });
}

/**
 * The ID of the credential of `credentials` that lets `scheduler` authorize
 * `execute` without a signature when it sends the call, for the longest after
 * `timestamp`: its secp256k1 key, of any role, live at `timestamp`, preferring
 * one that never expires, then the latest expiration, then the newest. A
 * removed credential has no public key, so it never matches. `undefined` if
 * none does. `execute` checks the expiration again at each settlement.
 */
export function findSchedulerCredential(
  credentials: readonly StoredSchedulerCredential[],
  scheduler: Address.Address,
  timestamp: bigint,
): bigint | undefined {
  const publicKey = encodeSecp256k1PublicKey(scheduler).toLowerCase();
  // An expiration of 0 never expires, so it sorts after every other.
  const lifetime = (expiration: number) =>
    expiration === 0 ? Number.POSITIVE_INFINITY : expiration;
  let found: { id: number; expiration: number } | undefined;
  for (const [id, credential] of credentials.entries()) {
    const expiration = Number(credential.expiration);
    if (
      Number(credential.keyType) === KeyType.Secp256k1 &&
      credential.publicKey.toLowerCase() === publicKey &&
      lifetime(expiration) >= Number(timestamp) &&
      (found === undefined ||
        lifetime(expiration) >= lifetime(found.expiration))
    ) {
      found = { id, expiration };
    }
  }
  return found === undefined ? undefined : BigInt(found.id);
}
