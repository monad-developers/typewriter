import { expect, test } from "bun:test";
import type { Hex } from "ox";
import { privateKeyToAccount } from "viem/accounts";
import { KeyType } from "./client";
import { encodeSecp256k1PublicKey } from "./encoding";
import {
  findSchedulerCredential,
  type StoredSchedulerCredential,
} from "./scheduler";
import { SchedulerRole } from "./typewriter-constants";

const SCHEDULER = privateKeyToAccount(`0x${"51".repeat(32)}`).address;
const OTHER = privateKeyToAccount(`0x${"07".repeat(32)}`).address;

const credential = (
  address: Hex.Hex,
  role: SchedulerRole,
  expiration = 0,
): StoredSchedulerCredential => ({
  expiration,
  keyType: KeyType.Secp256k1,
  role,
  publicKey: encodeSecp256k1PublicKey(address),
});

const REMOVED: StoredSchedulerCredential = {
  expiration: 0,
  keyType: 0,
  role: 0,
  publicKey: "0x",
};

test("findSchedulerCredential prefers the scheduler's credential that lives longest, of any role", () => {
  const credentials = [
    credential(SCHEDULER, SchedulerRole.Executor, 200),
    credential(OTHER, SchedulerRole.Executor),
    credential(SCHEDULER, SchedulerRole.Issuer, 300),
    credential(SCHEDULER, SchedulerRole.Executor, 250),
  ];
  expect(findSchedulerCredential(credentials, SCHEDULER, 100n)).toBe(2n);
  expect(findSchedulerCredential(credentials, OTHER, 100n)).toBe(1n);

  // One that never expires outlives every other, even an older one.
  credentials.unshift(credential(SCHEDULER, SchedulerRole.Root));
  expect(findSchedulerCredential(credentials, SCHEDULER, 100n)).toBe(0n);

  // Of two that never expire, the newest.
  credentials.push(credential(SCHEDULER, SchedulerRole.Executor));
  expect(findSchedulerCredential(credentials, SCHEDULER, 100n)).toBe(5n);
});

test("findSchedulerCredential skips one expired at the timestamp, as `execute` does", () => {
  const credentials = [
    credential(SCHEDULER, SchedulerRole.Executor, 100),
    credential(SCHEDULER, SchedulerRole.Executor, 50),
  ];
  // `execute` rejects an expiration before the timestamp, not at it.
  expect(findSchedulerCredential(credentials, SCHEDULER, 100n)).toBe(0n);
  expect(findSchedulerCredential(credentials, SCHEDULER, 101n)).toBeUndefined();
});

test("findSchedulerCredential skips a removed credential", () => {
  const credentials = [
    credential(SCHEDULER, SchedulerRole.Root, 500),
    credential(SCHEDULER, SchedulerRole.Executor),
  ];
  expect(findSchedulerCredential(credentials, SCHEDULER, 0n)).toBe(1n);
  // `schedulerRemoveCredential` deletes it, which zeroes every field.
  credentials[1] = REMOVED;
  expect(findSchedulerCredential(credentials, SCHEDULER, 0n)).toBe(0n);
});

test("findSchedulerCredential finds nothing without a credential of the scheduler", () => {
  expect(findSchedulerCredential([], SCHEDULER, 0n)).toBeUndefined();
  expect(findSchedulerCredential([REMOVED], SCHEDULER, 0n)).toBeUndefined();
  expect(
    findSchedulerCredential(
      [credential(OTHER, SchedulerRole.Root)],
      SCHEDULER,
      0n,
    ),
  ).toBeUndefined();
  // A P-256 credential, even with the same bytes, is another key.
  expect(
    findSchedulerCredential(
      [{ ...credential(SCHEDULER, SchedulerRole.Root), keyType: KeyType.P256 }],
      SCHEDULER,
      0n,
    ),
  ).toBeUndefined();
});
