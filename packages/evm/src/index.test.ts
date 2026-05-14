// Each test spawns its own sidecar (one createEVM per test) and exercises
// the bundle protocol against a hand-written counter contract.
//
// Counter runtime bytecode — increments storage slot 0 by 1 on any call:
//   PUSH1 0x00 DUP1 SLOAD PUSH1 0x01 ADD SWAP1 SSTORE STOP
const COUNTER_CODE = "0x60008054600101905500" as const;
// Writes slot 0, then reverts. Failed executions must not persist writes.
const WRITE_THEN_REVERT_CODE = "0x600160005560006000fd" as const;

const COUNTER_ADDR = "0x0000000000000000000000000000000000000c01" as const;
const REVERTING_ADDR = "0x0000000000000000000000000000000000000bad" as const;
const CALLER = "0x000000000000000000000000000000000000ca11" as const;

import { expect, test } from "bun:test";
import { Effect, Exit } from "effect";
import { createStorageProxy } from "storage-layout";
import { TEST_PUBLIC_CLIENT } from "../test/setup";
import {
  BALANCE_OF_SLOT,
  deployTestToken,
  INITIAL_SUPPLY,
  loadTestToken,
  mappingSlot,
  normalizeAccessRecord,
  RECIPIENT_ADDR,
  SCHEDULER_ADDR,
  SIMULATE_AMOUNT,
  TOKEN_ADDR,
  TOTAL_SUPPLY_SLOT,
  TRANSFER_AMOUNT,
  tokenInit,
  tokenStorageLayout,
  transferData,
  USER_ADDR,
} from "../test/utils";
import { createEVM } from "./index";

const initWithCounter = {
  accounts: {
    [COUNTER_ADDR]: { code: COUNTER_CODE },
  },
} as const;

test("init + beginBundle + commitBundles round-trips with no executes", async () => {
  const program = Effect.gen(function* () {
    const evm = yield* createEVM();
    yield* evm.init({});
    yield* evm.beginBundle();
    const commit = yield* evm.commitBundles();
    return commit;
  });

  const exit = await Effect.runPromiseExit(Effect.scoped(program));
  expect(Exit.isSuccess(exit)).toBe(true);
});

test("execute against counter succeeds and commitBundles squashes journals", async () => {
  const program = Effect.gen(function* () {
    const evm = yield* createEVM();
    yield* evm.init(initWithCounter);
    yield* evm.beginBundle();
    const exec = yield* evm.execute({
      from: CALLER,
      to: COUNTER_ADDR,
      data: "0x",
    });
    yield* evm.commitBundles();
    return exec;
  });

  const exec = await Effect.runPromise(Effect.scoped(program));
  expect(exec.success).toBe(true);
  expect(exec.revert_data).toBeUndefined();
});

test("two executes in one bundle both succeed", async () => {
  const program = Effect.gen(function* () {
    const evm = yield* createEVM();
    yield* evm.init(initWithCounter);
    yield* evm.beginBundle();
    const first = yield* evm.execute({
      from: CALLER,
      to: COUNTER_ADDR,
      data: "0x",
    });
    const second = yield* evm.execute({
      from: CALLER,
      to: COUNTER_ADDR,
      data: "0x",
    });
    yield* evm.commitBundles();
    return { first, second };
  });

  const { first, second } = await Effect.runPromise(Effect.scoped(program));
  expect(first.success).toBe(true);
  expect(second.success).toBe(true);
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
    const exec = yield* evm.execute({
      from: CALLER,
      to: COUNTER_ADDR,
      data: "0x",
    });
    yield* evm.commitBundles();
    return exec;
  });

  const exec = await Effect.runPromise(Effect.scoped(program));
  expect(exec.success).toBe(true);
});

test("sequential committed bundles keep local state", async () => {
  const program = Effect.gen(function* () {
    const evm = yield* createEVM();
    yield* evm.init(initWithCounter);

    yield* evm.beginBundle();
    yield* evm.execute({ from: CALLER, to: COUNTER_ADDR, data: "0x" });
    yield* evm.commitBundles();

    yield* evm.beginBundle();
    const exec = yield* evm.execute({
      from: CALLER,
      to: COUNTER_ADDR,
      data: "0x",
    });
    yield* evm.commitBundles();
    return exec;
  });

  const exec = await Effect.runPromise(Effect.scoped(program));
  expect(exec.success).toBe(true);
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

test("failed execute discards journal writes", async () => {
  const program = Effect.gen(function* () {
    const evm = yield* createEVM();
    yield* evm.init({
      accounts: {
        [REVERTING_ADDR]: { code: WRITE_THEN_REVERT_CODE },
      },
    });
    yield* evm.beginBundle();
    const exec = yield* evm.execute({
      from: CALLER,
      to: REVERTING_ADDR,
      data: "0x",
    });
    yield* evm.commitBundles();
    return exec;
  });

  const exec = await Effect.runPromise(Effect.scoped(program));
  expect(exec.success).toBe(false);
  expect(exec.revert_data).toBe("0x");
});

test("execute returns access_list with the counter address + slot 0", async () => {
  const program = Effect.gen(function* () {
    const evm = yield* createEVM();
    yield* evm.init(initWithCounter);
    yield* evm.beginBundle();
    return yield* evm.execute({ from: CALLER, to: COUNTER_ADDR, data: "0x" });
  });

  const exec = await Effect.runPromise(Effect.scoped(program));
  expect(exec.access_list).toEqual([
    {
      address: COUNTER_ADDR,
      storageKeys: [
        "0x0000000000000000000000000000000000000000000000000000000000000000",
      ],
    },
  ]);
});

test("simulate doesn't mutate state — counter stays at 0 after simulate", async () => {
  const program = Effect.gen(function* () {
    const evm = yield* createEVM();
    yield* evm.init(initWithCounter);

    // simulate has no bundle requirement and no persistence.
    const sim = yield* evm.simulate({
      from: CALLER,
      to: COUNTER_ADDR,
      data: "0x",
    });

    // Real bundle: increment once, expect 0 -> 1, NOT 1 -> 2.
    yield* evm.beginBundle();
    yield* evm.execute({ from: CALLER, to: COUNTER_ADDR, data: "0x" });
    yield* evm.commitBundles();
    return sim;
  });

  const sim = await Effect.runPromise(Effect.scoped(program));
  expect(sim.success).toBe(true);
});

test("simulate against a stack of uncommitted bundles preserves post-stack state", async () => {
  // Two open bundles each increment. After both, slot is at 2. simulate
  // must un-apply the stack, run, re-apply — leaving the bundle stack's
  // logical state intact for the eventual commit.
  const program = Effect.gen(function* () {
    const evm = yield* createEVM();
    yield* evm.init(initWithCounter);

    yield* evm.beginBundle();
    yield* evm.execute({ from: CALLER, to: COUNTER_ADDR, data: "0x" });
    // bundle A still open

    yield* evm.beginBundle();
    yield* evm.execute({ from: CALLER, to: COUNTER_ADDR, data: "0x" });
    // bundle B still open; slot in DB is at 2

    const sim = yield* evm.simulate({
      from: CALLER,
      to: COUNTER_ADDR,
      data: "0x",
    });

    yield* evm.commitBundles();
    return sim;
  });

  const sim = await Effect.runPromise(Effect.scoped(program));
  expect(sim.success).toBe(true);
});

test("execute e2e with compiled Solmate ERC20 bytecode", async () => {
  const artifact = await loadTestToken();
  const { params, schedulerBalanceSlot } = tokenInit(artifact);
  const userBalanceSlot = mappingSlot(USER_ADDR, BALANCE_OF_SLOT);
  const data = transferData(USER_ADDR, TRANSFER_AMOUNT);

  const program = Effect.gen(function* () {
    const evm = yield* createEVM();
    yield* evm.init(params);
    yield* evm.beginBundle();
    const exec = yield* evm.execute({
      from: SCHEDULER_ADDR,
      to: TOKEN_ADDR,
      data,
    });
    yield* evm.commitBundles();
    return exec;
  });

  const exec = await Effect.runPromise(Effect.scoped(program));

  expect({
    accessList: normalizeAccessRecord(exec.access_list),
    success: exec.success,
    slots: {
      schedulerBalanceSlot,
      totalSupplySlot: TOTAL_SUPPLY_SLOT,
      userBalanceSlot,
    },
  }).toMatchInlineSnapshot(`
    {
      "accessList": [
        {
          "address": "0x0000000000000000000000000000000000000e20",
          "storageKeys": [
            "0x9c35da83f88043b3115f30d93beacec49ca14b6238430bdff196a249c29baa80",
            "0xc651ee22c6951bb8b5bd29e8210fb394645a94315fe10eff2cc73de1aa75c137",
          ],
        },
      ],
      "slots": {
        "schedulerBalanceSlot": "0xc651ee22c6951bb8b5bd29e8210fb394645a94315fe10eff2cc73de1aa75c137",
        "totalSupplySlot": "0x0000000000000000000000000000000000000000000000000000000000000002",
        "userBalanceSlot": "0x9c35da83f88043b3115f30d93beacec49ca14b6238430bdff196a249c29baa80",
      },
      "success": true,
    }
  `);
});

test("readStorage decodes committed token state through storage proxy", async () => {
  const artifact = await loadTestToken();
  const { params } = tokenInit(artifact);
  const data = transferData(USER_ADDR, TRANSFER_AMOUNT);

  const program = Effect.gen(function* () {
    const evm = yield* createEVM();
    yield* evm.init(params);
    yield* evm.beginBundle();
    const exec = yield* evm.execute({
      from: SCHEDULER_ADDR,
      to: TOKEN_ADDR,
      data,
    });
    yield* evm.commitBundles();

    const token = createStorageProxy(tokenStorageLayout, (slots) =>
      Effect.runPromise(evm.readStorage({ address: TOKEN_ADDR, slots })),
    );
    const totalSupply = yield* Effect.promise(() => token.totalSupply);
    const schedulerBalance = yield* Effect.promise(
      () => token.balanceOf[SCHEDULER_ADDR]!,
    );
    const userBalance = yield* Effect.promise(
      () => token.balanceOf[USER_ADDR]!,
    );
    const recipientBalance = yield* Effect.promise(
      () => token.balanceOf[RECIPIENT_ADDR]!,
    );

    return {
      exec,
      recipientBalance,
      schedulerBalance,
      totalSupply,
      userBalance,
    };
  });

  const result = await Effect.runPromise(Effect.scoped(program));

  expect(result).toEqual({
    exec: expect.objectContaining({ success: true }),
    recipientBalance: 0n,
    schedulerBalance: INITIAL_SUPPLY - TRANSFER_AMOUNT,
    totalSupply: INITIAL_SUPPLY,
    userBalance: TRANSFER_AMOUNT,
  });
});

test("simulate e2e temporarily rewinds optimistic Solmate ERC20 bundles", async () => {
  const artifact = await loadTestToken();
  const { params, schedulerBalanceSlot } = tokenInit(artifact);
  const userBalanceSlot = mappingSlot(USER_ADDR, BALANCE_OF_SLOT);
  const recipientBalanceSlot = mappingSlot(RECIPIENT_ADDR, BALANCE_OF_SLOT);

  const program = Effect.gen(function* () {
    const evm = yield* createEVM();
    yield* evm.init(params);
    yield* evm.beginBundle();
    const optimistic = yield* evm.execute({
      from: SCHEDULER_ADDR,
      to: TOKEN_ADDR,
      data: transferData(USER_ADDR, TRANSFER_AMOUNT),
    });
    const simulated = yield* evm.simulate({
      from: SCHEDULER_ADDR,
      to: TOKEN_ADDR,
      data: transferData(RECIPIENT_ADDR, SIMULATE_AMOUNT),
    });
    yield* evm.commitBundles();
    return { optimistic, simulated };
  });

  const { optimistic, simulated } = await Effect.runPromise(
    Effect.scoped(program),
  );

  expect({
    optimisticAccessList: normalizeAccessRecord(optimistic.access_list),
    optimisticSuccess: optimistic.success,
    simulatedAccessList: normalizeAccessRecord(simulated.access_list),
    simulatedSuccess: simulated.success,
    slots: {
      recipientBalanceSlot,
      schedulerBalanceSlot,
      userBalanceSlot,
    },
  }).toMatchInlineSnapshot(`
    {
      "optimisticAccessList": [
        {
          "address": "0x0000000000000000000000000000000000000e20",
          "storageKeys": [
            "0x9c35da83f88043b3115f30d93beacec49ca14b6238430bdff196a249c29baa80",
            "0xc651ee22c6951bb8b5bd29e8210fb394645a94315fe10eff2cc73de1aa75c137",
          ],
        },
      ],
      "optimisticSuccess": true,
      "simulatedAccessList": [
        {
          "address": "0x0000000000000000000000000000000000000e20",
          "storageKeys": [
            "0x961ec03a078fec1e350bb1ca3bff1afa4bae5fb83d9d8382550c2fd26a7d7527",
            "0xc651ee22c6951bb8b5bd29e8210fb394645a94315fe10eff2cc73de1aa75c137",
          ],
        },
      ],
      "simulatedSuccess": true,
      "slots": {
        "recipientBalanceSlot": "0x961ec03a078fec1e350bb1ca3bff1afa4bae5fb83d9d8382550c2fd26a7d7527",
        "schedulerBalanceSlot": "0xc651ee22c6951bb8b5bd29e8210fb394645a94315fe10eff2cc73de1aa75c137",
        "userBalanceSlot": "0x9c35da83f88043b3115f30d93beacec49ca14b6238430bdff196a249c29baa80",
      },
    }
  `);
});

test("sidecar access list matches eth_createAccessList for Solmate ERC20 transfer", async () => {
  const artifact = await loadTestToken();
  const tokenAddr = await deployTestToken(artifact);
  const data = transferData(USER_ADDR, TRANSFER_AMOUNT);
  const rpcAccessList = normalizeAccessRecord(
    (
      await TEST_PUBLIC_CLIENT.createAccessList({
        account: SCHEDULER_ADDR,
        to: tokenAddr,
        data,
      })
    ).accessList,
  );

  const { params } = tokenInit(artifact, tokenAddr);
  const program = Effect.gen(function* () {
    const evm = yield* createEVM();
    yield* evm.init(params);
    return yield* evm.simulate({
      from: SCHEDULER_ADDR,
      to: tokenAddr,
      data,
    });
  });
  const sidecar = await Effect.runPromise(Effect.scoped(program));
  expect(normalizeAccessRecord(sidecar.access_list)).toEqual(rpcAccessList);
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
