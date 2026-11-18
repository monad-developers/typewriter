import { expect, test } from "bun:test";
import { Effect } from "effect";
import type { Hex } from "ox";
import {
  type AccessList,
  createEVM,
  type ExecuteResult,
  type Spec,
} from "typewriter-evm";
import { accessList, gasLimit } from "./gas";

const CALLER = "0x00000000000000000000000000000000000000ca";
const WRITER = "0x00000000000000000000000000000000000000a1";
// Stores 1 at each 32-byte calldata word, as a slot.
const WRITER_CODE = "0x60005b803611156016578035600190556020016002565b00";

const word = (slot: number) => slot.toString(16).padStart(64, "0");

const success = (result: ExecuteResult) => {
  if (result.status !== "success") throw new Error(result.status);
  return result;
};

/** Runs each of `calldatas` in turn on one EVM, each with `list`. */
const run = (
  spec: Spec,
  code: Hex.Hex,
  calldatas: Hex.Hex[],
  list: AccessList = [],
) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const evm = yield* createEVM({
          spec,
          accounts: { [WRITER]: { code } },
        });
        return yield* Effect.forEach(calldatas, (data) =>
          evm
            .execute({ from: CALLER, to: WRITER, data, access_list: list })
            .pipe(
              Effect.map(success),
              Effect.map((executeResult) => ({
                executeResult,
                calldata: data,
              })),
            ),
        );
      }),
    ),
  );

/**
 * Runs `calldatas` alone, then joined as one transaction with the access list
 * of the runs alone. Returns the runs alone and the joined run's gas.
 */
const settle = async (spec: Spec, code: Hex.Hex, calldatas: Hex.Hex[]) => {
  const alone = await run(spec, code, calldatas);
  const list = accessList(alone);
  const joined =
    `0x${calldatas.map((data) => data.slice(2)).join("")}` as const;
  const [together] = await run(spec, code, [joined], list);
  return { alone, list, gasUsed: together!.executeResult.gas_used };
};

// Pages 0, 1 and 7.
const slots = [
  ...Array.from({ length: 20 }, (_, slot) => slot),
  ...Array.from({ length: 20 }, (_, slot) => 128 + slot),
  1_000,
];
const writes = slots.map((slot) => `0x${word(slot)}` as const);

for (const spec of ["MonadEight", "MonadNine", "MonadTen"] as const) {
  test(`a settlement's gas limit covers writes to several pages under ${spec}`, async () => {
    const { alone, list, gasUsed } = await settle(spec, WRITER_CODE, writes);

    expect(gasLimit(alone, list)).toBeGreaterThanOrEqual(gasUsed);
  });
}

test("a settlement lists one key per page it touches under MonadTen", async () => {
  const { list, gasUsed } = await settle("MonadTen", WRITER_CODE, writes);
  const joined = `0x${slots.map(word).join("")}` as const;
  const [unlisted] = await run("MonadTen", WRITER_CODE, [joined]);

  expect(list).toEqual([
    {
      address: WRITER,
      storageKeys: [0, 128, 1_000].map((slot) => `0x${word(slot)}` as const),
    },
  ]);
  // Each page's first touch is warm for a key, and the address costs once.
  expect(unlisted!.executeResult.gas_used - gasUsed).toBe(
    3 * (8_000 - 1_900) - 2_400,
  );
});

for (const spec of ["MonadEight", "MonadNine"] as const) {
  test(`a settlement lists each slot it touches under ${spec}`, async () => {
    const { list, gasUsed } = await settle(spec, WRITER_CODE, writes);
    const joined = `0x${slots.map(word).join("")}` as const;
    const [unlisted] = await run(spec, WRITER_CODE, [joined]);

    expect(list).toEqual([{ address: WRITER, storageKeys: writes }]);
    // Each cold SSTORE (8,100) is warm for a key, and the address costs once.
    expect(unlisted!.executeResult.gas_used - gasUsed).toBe(
      slots.length * (8_100 - 1_900) - 2_400,
    );
  });
}

for (const spec of ["MonadNine", "MonadTen"] as const) {
  test(`a settlement's gas limit covers executions that touch the same slot under ${spec}`, async () => {
    const { alone, list, gasUsed } = await settle(spec, WRITER_CODE, [
      `0x${word(0)}`,
      `0x${word(0)}`,
    ]);

    expect(gasLimit(alone, list)).toBeGreaterThanOrEqual(gasUsed);
  });
}

// Writes slot 0, whatever its calldata.
const FIXED_WRITER_CODE = "0x600160005500";

test("a settlement's gas limit covers the calldata floor of executions that share a page", async () => {
  const data = `0x${"ab".repeat(1_024)}` as const;
  const { alone, list, gasUsed } = await settle("MonadTen", FIXED_WRITER_CODE, [
    data,
    data,
  ]);

  expect(gasLimit(alone, list)).toBeGreaterThanOrEqual(gasUsed);
});

// Reads slots 0 and 128, whatever its calldata.
const READER_CODE = "0x600054506080545000";

test("a settlement's gas limit covers the calldata floor of an execution whose pages are listed", async () => {
  const data = `0x${"ff".repeat(2_048)}` as const;
  const { alone, list, gasUsed } = await settle("MonadTen", READER_CODE, [
    data,
  ]);

  // Floor-bound alone and with the list.
  expect(alone[0]!.executeResult.gas_used).toBe(21_000 + 40 * 2_048);
  expect(gasUsed).toBe(21_000 + 40 * 2_048);
  expect(gasLimit(alone, list)).toBeGreaterThanOrEqual(gasUsed);
});
