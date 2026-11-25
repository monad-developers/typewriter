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

const SCHEDULER = privateKeyToAccount(`0x${"51".repeat(32)}`);
const OTHER = privateKeyToAccount(`0x${"07".repeat(32)}`);

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

test("findSchedulerCredential finds the newest credential of the scheduler, of any role or expiration", () => {
  const credentials = [
    credential(SCHEDULER.address, SchedulerRole.Root),
    credential(OTHER.address, SchedulerRole.Executor),
    credential(SCHEDULER.address, SchedulerRole.Issuer, 100),
    REMOVED,
  ];

  // `execute` checks the expiration, so an expired credential still matches.
  expect(findSchedulerCredential(credentials, SCHEDULER.address)).toBe(2n);
  expect(findSchedulerCredential(credentials, OTHER.address)).toBe(1n);
});

test("findSchedulerCredential skips a removed credential", () => {
  const credentials = [
    credential(SCHEDULER.address, SchedulerRole.Root),
    credential(SCHEDULER.address, SchedulerRole.Executor),
  ];
  expect(findSchedulerCredential(credentials, SCHEDULER.address)).toBe(1n);
  // `schedulerRemoveCredential` deletes it, which zeroes every field.
  credentials[1] = REMOVED;
  expect(findSchedulerCredential(credentials, SCHEDULER.address)).toBe(0n);
});

test("findSchedulerCredential finds nothing without a credential of the scheduler", () => {
  const scheduler = SCHEDULER.address;
  expect(findSchedulerCredential([], scheduler)).toBeUndefined();
  expect(findSchedulerCredential([REMOVED], scheduler)).toBeUndefined();
  expect(
    findSchedulerCredential(
      [credential(OTHER.address, SchedulerRole.Root)],
      scheduler,
    ),
  ).toBeUndefined();
  // A P-256 credential, even with the same bytes, is another key.
  expect(
    findSchedulerCredential(
      [{ ...credential(scheduler, SchedulerRole.Root), keyType: KeyType.P256 }],
      scheduler,
    ),
  ).toBeUndefined();
});
