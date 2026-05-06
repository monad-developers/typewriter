// Each test spawns its own sidecar (one createEVM per test) and exercises
// the bundle protocol against a hand-written counter contract.
//
// Counter runtime bytecode — increments storage slot 0 by 1 on any call:
//   PUSH1 0x00 DUP1 SLOAD PUSH1 0x01 ADD SWAP1 SSTORE STOP
const COUNTER_CODE = "0x60008054600101905500" as const;

const COUNTER_ADDR = "0x0000000000000000000000000000000000000c01" as const;
const CALLER = "0x000000000000000000000000000000000000ca11" as const;

import { expect, test } from "bun:test";
import { Effect, Exit } from "effect";
import { createEVM } from "./index";

const initWithCounter = {
  accounts: {
    [COUNTER_ADDR]: { code: COUNTER_CODE },
  },
} as const;

test("init + beginBundle + commitBundle round-trips with no executes", async () => {
  const program = Effect.gen(function* () {
    const evm = yield* createEVM();
    yield* evm.init({});
    yield* evm.beginBundle();
    const commit = yield* evm.commitBundle();
    return commit;
  });

  const exit = await Effect.runPromiseExit(Effect.scoped(program));
  expect(Exit.isSuccess(exit)).toBe(true);
});

test("execute against counter writes slot 0; commit returns state_diff", async () => {
  const program = Effect.gen(function* () {
    const evm = yield* createEVM();
    yield* evm.init(initWithCounter);
    yield* evm.beginBundle();
    const exec = yield* evm.execute({
      from: CALLER,
      to: COUNTER_ADDR,
      data: "0x",
    });
    const commit = yield* evm.commitBundle();
    return { exec, commit };
  });

  const result = await Effect.runPromise(Effect.scoped(program));
  expect(result.exec.success).toBe(true);
  expect(result.exec.revert_data).toBeUndefined();
  expect(result.commit.state_diff[COUNTER_ADDR]?.storage).toEqual({
    "0x0000000000000000000000000000000000000000000000000000000000000000":
      "0x0000000000000000000000000000000000000000000000000000000000000001",
  });
});

test("two executes in one bundle accumulate; commit reports final value", async () => {
  const program = Effect.gen(function* () {
    const evm = yield* createEVM();
    yield* evm.init(initWithCounter);
    yield* evm.beginBundle();
    yield* evm.execute({ from: CALLER, to: COUNTER_ADDR, data: "0x" });
    yield* evm.execute({ from: CALLER, to: COUNTER_ADDR, data: "0x" });
    return yield* evm.commitBundle();
  });

  const commit = await Effect.runPromise(Effect.scoped(program));
  expect(commit.state_diff[COUNTER_ADDR]?.storage).toEqual({
    "0x0000000000000000000000000000000000000000000000000000000000000000":
      "0x0000000000000000000000000000000000000000000000000000000000000002",
  });
});

test("revertBundle drops writes; next bundle starts from pre-revert state", async () => {
  const program = Effect.gen(function* () {
    const evm = yield* createEVM();
    yield* evm.init(initWithCounter);

    // Bundle 1: increment, revert.
    yield* evm.beginBundle();
    yield* evm.execute({ from: CALLER, to: COUNTER_ADDR, data: "0x" });
    yield* evm.revertBundle();

    // Bundle 2: increment, commit. Slot should go 0 -> 1, not 1 -> 2.
    yield* evm.beginBundle();
    yield* evm.execute({ from: CALLER, to: COUNTER_ADDR, data: "0x" });
    return yield* evm.commitBundle();
  });

  const commit = await Effect.runPromise(Effect.scoped(program));
  expect(commit.state_diff[COUNTER_ADDR]?.storage).toEqual({
    "0x0000000000000000000000000000000000000000000000000000000000000000":
      "0x0000000000000000000000000000000000000000000000000000000000000001",
  });
});

test("sequential committed bundles see each other's writes", async () => {
  const program = Effect.gen(function* () {
    const evm = yield* createEVM();
    yield* evm.init(initWithCounter);

    yield* evm.beginBundle();
    yield* evm.execute({ from: CALLER, to: COUNTER_ADDR, data: "0x" });
    yield* evm.commitBundle();

    yield* evm.beginBundle();
    yield* evm.execute({ from: CALLER, to: COUNTER_ADDR, data: "0x" });
    return yield* evm.commitBundle();
  });

  // Second bundle should observe prior value 1 and write 2.
  const commit = await Effect.runPromise(Effect.scoped(program));
  expect(commit.state_diff[COUNTER_ADDR]?.storage).toEqual({
    "0x0000000000000000000000000000000000000000000000000000000000000000":
      "0x0000000000000000000000000000000000000000000000000000000000000002",
  });
});

test("execute outside an open bundle fails", async () => {
  const program = Effect.gen(function* () {
    const evm = yield* createEVM();
    yield* evm.init(initWithCounter);
    return yield* evm.execute({
      from: CALLER,
      to: COUNTER_ADDR,
      data: "0x",
    });
  });

  const exit = await Effect.runPromiseExit(Effect.scoped(program));
  expect(Exit.isFailure(exit)).toBe(true);
});

test("init twice fails", async () => {
  const program = Effect.gen(function* () {
    const evm = yield* createEVM();
    yield* evm.init({});
    yield* evm.init({});
  });

  const exit = await Effect.runPromiseExit(Effect.scoped(program));
  expect(Exit.isFailure(exit)).toBe(true);
});
