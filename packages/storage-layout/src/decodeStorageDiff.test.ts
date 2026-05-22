import { expect, test } from "bun:test";
import { Hash, Hex } from "ox";
import {
  expectSingleSlot,
  layout,
  OWNER,
  PACKED_OWNER_PAUSED,
  PACKED_OWNER_UNPAUSED,
  SPENDER,
  writesToStorage,
} from "../test/utils";
import { decodeStorageDiff, encodeStorageDiff, getStorageSlot } from "./index";

function writesToStorageDiff(diff: ReturnType<typeof encodeStorageDiff>) {
  return {
    pre: writesToStorage(diff.pre),
    post: writesToStorage(diff.post),
  };
}

test("decodeStorageDiff decodes sparse raw slot diffs into sparse path diffs", () => {
  const ownerSlot = expectSingleSlot(getStorageSlot(layout, "owner"));
  const supplySlot = expectSingleSlot(getStorageSlot(layout, "totalSupply"));

  expect(
    decodeStorageDiff(layout, {
      pre: {
        [ownerSlot]: PACKED_OWNER_PAUSED,
        [supplySlot]: Hex.fromNumber(1n, { size: 32 }),
      },
      post: {
        [ownerSlot]: `0x${"00".repeat(11)}01${SPENDER.slice(2)}`,
        [supplySlot]: Hex.fromNumber(2n, { size: 32 }),
      },
    }),
  ).toEqual({
    pre: { owner: OWNER, totalSupply: 1n },
    post: { owner: SPENDER, totalSupply: 2n },
  });
});

test("decodeStorageDiff treats one-sided raw slot entries as zero", () => {
  const supplySlot = expectSingleSlot(getStorageSlot(layout, "totalSupply"));

  expect(
    decodeStorageDiff(layout, {
      pre: { [supplySlot]: Hex.fromNumber(1n, { size: 32 }) },
      post: {},
    }),
  ).toEqual({
    pre: { totalSupply: 1n },
    post: { totalSupply: 0n },
  });
  expect(
    decodeStorageDiff(layout, {
      pre: {},
      post: { [supplySlot]: Hex.fromNumber(2n, { size: 32 }) },
    }),
  ).toEqual({
    pre: { totalSupply: 0n },
    post: { totalSupply: 2n },
  });
});

test("decodeStorageDiff decodes packed fields", () => {
  const ownerSlot = expectSingleSlot(getStorageSlot(layout, "owner"));

  expect(
    decodeStorageDiff(layout, {
      pre: { [ownerSlot]: PACKED_OWNER_PAUSED },
      post: { [ownerSlot]: PACKED_OWNER_UNPAUSED },
    }),
  ).toEqual({
    pre: { paused: true },
    post: { paused: false },
  });
});

test("decodeStorageDiff decodes long bytes diffs", () => {
  const before = `0x${"11".repeat(33)}` as const;
  const after = `0x${"22".repeat(33)}` as const;
  const diff = writesToStorageDiff(
    encodeStorageDiff(layout, {
      pre: { rawBytes: before },
      post: { rawBytes: after },
    }),
  );

  expect(decodeStorageDiff(layout, diff)).toEqual({
    pre: { rawBytes: before },
    post: { rawBytes: after },
  });
});

test("decodeStorageDiff rejects long bytes payload-only diffs", () => {
  const before = `0x${"11".repeat(33)}` as const;
  const after = `0x${"22".repeat(33)}` as const;
  const diff = writesToStorageDiff(
    encodeStorageDiff(layout, {
      pre: { rawBytes: before },
      post: { rawBytes: after },
    }),
  );
  const rootSlot = expectSingleSlot(getStorageSlot(layout, "rawBytes"));
  const payloadSlot = Hex.fromNumber(BigInt(Hash.keccak256(rootSlot)), {
    size: 32,
  });

  delete diff.pre[rootSlot];
  delete diff.post[rootSlot];

  expect(() => decodeStorageDiff(layout, diff)).toThrow(
    `storage slot diff cannot be decoded to a concrete storage path: ${payloadSlot}`,
  );
});

test("decodeStorageDiff rejects slots whose paths cannot be inferred", () => {
  const diff = writesToStorageDiff(
    encodeStorageDiff(layout, {
      pre: { [`balances[${OWNER}]`]: 1n },
      post: { [`balances[${OWNER}]`]: 2n },
    }),
  );

  expect(() => decodeStorageDiff(layout, diff)).toThrow(
    "storage slot diff cannot be decoded to a concrete storage path",
  );
});

test("decodeStorageDiff decodes known keyed mapping paths", () => {
  const diff = writesToStorageDiff(
    encodeStorageDiff(layout, {
      pre: { [`balances[${OWNER}]`]: 1n },
      post: { [`balances[${OWNER}]`]: 2n },
    }),
  );

  expect(decodeStorageDiff(layout, diff, [`balances[${OWNER}]`])).toEqual({
    pre: { [`balances[${OWNER}]`]: 1n },
    post: { [`balances[${OWNER}]`]: 2n },
  });
});

test("decodeStorageDiff decodes known nested keyed mapping paths", () => {
  const diff = writesToStorageDiff(
    encodeStorageDiff(layout, {
      pre: { [`allowances[${OWNER}][${SPENDER}]`]: 1n },
      post: { [`allowances[${OWNER}][${SPENDER}]`]: 2n },
    }),
  );

  expect(
    decodeStorageDiff(layout, diff, [`allowances[${OWNER}][${SPENDER}]`]),
  ).toEqual({
    pre: { [`allowances[${OWNER}][${SPENDER}]`]: 1n },
    post: { [`allowances[${OWNER}][${SPENDER}]`]: 2n },
  });
});
