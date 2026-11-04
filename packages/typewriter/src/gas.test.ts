import { expect, test } from "bun:test";
import { Effect } from "effect";
import type { Hex } from "ox";
import { createEVM, type ExecuteResult, type Spec } from "typewriter-evm";
import { settlementGasLimit } from "./gas";

const CALLER = "0x00000000000000000000000000000000000000ca";
const WRITER = "0x00000000000000000000000000000000000000a1";
// Stores 1 at each 32-byte calldata word, as a slot.
const WRITER_CODE = "0x60005b803611156016578035600190556020016002565b00";

const word = (slot: number) => slot.toString(16).padStart(64, "0");

const success = (result: ExecuteResult) => {
  if (result.status !== "success") throw new Error(result.status);
  return result;
};

const run = (spec: Spec, calldatas: Hex.Hex[]) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const evm = yield* createEVM({
          spec,
          accounts: { [WRITER]: { code: WRITER_CODE } },
        });
        return yield* Effect.forEach(calldatas, (data) =>
          evm
            .execute({ from: CALLER, to: WRITER, data })
            .pipe(Effect.map(success)),
        );
      }),
    ),
  );

const slots = Array.from({ length: 20 }, (_, slot) => slot);

for (const spec of ["MonadNine", "MonadTen"] as const) {
  test(`a settlement's gas limit covers writes to one page under ${spec}`, async () => {
    const alone = await run(
      spec,
      slots.map((slot) => `0x${word(slot)}` as const),
    );
    const [together] = await run(spec, [`0x${slots.map(word).join("")}`]);

    expect(settlementGasLimit(alone)).toBeGreaterThanOrEqual(
      together!.gas_used,
    );
  });
}
