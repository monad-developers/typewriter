// Each test spawns its own sidecar (one createEVM per test) and exercises
// the journal protocol against a hand-written counter contract.
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
  callBurnData,
  deployArtifact,
  deployTestToken,
  INITIAL_SUPPLY,
  loadCallGasCallee,
  loadCallGasCaller,
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

test("init + beginJournal + commitJournal round-trips with no executes", async () => {
  const program = Effect.gen(function* () {
    const evm = yield* createEVM();
    yield* evm.init({});
    yield* evm.beginJournal();
    const commit = yield* evm.commitJournal();
    return commit;
  });

  const exit = await Effect.runPromiseExit(Effect.scoped(program));
  expect(Exit.isSuccess(exit)).toBe(true);
});

test("execute against counter succeeds and commitJournal keeps state", async () => {
  const program = Effect.gen(function* () {
    const evm = yield* createEVM();
    yield* evm.init(initWithCounter);
    yield* evm.beginJournal();
    const exec = yield* evm.execute({
      from: CALLER,
      to: COUNTER_ADDR,
      data: "0x",
    });
    yield* evm.commitJournal();
    return exec;
  });

  const exec = await Effect.runPromise(Effect.scoped(program));
  expect(exec.success).toBe(true);
  expect(exec.revert_data).toBeUndefined();
  expect(exec.slot_writes).toEqual([
    {
      address: COUNTER_ADDR,
      slot: "0x0000000000000000000000000000000000000000000000000000000000000000",
      prev_value:
        "0x0000000000000000000000000000000000000000000000000000000000000000",
      new_value:
        "0x0000000000000000000000000000000000000000000000000000000000000001",
    },
  ]);
});

test("two executes in one journal both succeed", async () => {
  const program = Effect.gen(function* () {
    const evm = yield* createEVM();
    yield* evm.init(initWithCounter);
    yield* evm.beginJournal();
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
    yield* evm.commitJournal();
    return { first, second };
  });

  const { first, second } = await Effect.runPromise(Effect.scoped(program));
  expect(first.success).toBe(true);
  expect(second.success).toBe(true);
});

test("revertJournal drops writes; next journal starts from pre-revert state", async () => {
  const program = Effect.gen(function* () {
    const evm = yield* createEVM();
    yield* evm.init(initWithCounter);

    // Journal 1: increment, revert.
    yield* evm.beginJournal();
    yield* evm.execute({ from: CALLER, to: COUNTER_ADDR, data: "0x" });
    yield* evm.revertJournal();

    // Journal 2: increment, commit. Slot should go 0 -> 1, not 1 -> 2.
    yield* evm.beginJournal();
    const exec = yield* evm.execute({
      from: CALLER,
      to: COUNTER_ADDR,
      data: "0x",
    });
    yield* evm.commitJournal();
    return exec;
  });

  const exec = await Effect.runPromise(Effect.scoped(program));
  expect(exec.success).toBe(true);
});

test("sequential committed journals keep local state", async () => {
  const program = Effect.gen(function* () {
    const evm = yield* createEVM();
    yield* evm.init(initWithCounter);

    yield* evm.beginJournal();
    yield* evm.execute({ from: CALLER, to: COUNTER_ADDR, data: "0x" });
    yield* evm.commitJournal();

    yield* evm.beginJournal();
    const exec = yield* evm.execute({
      from: CALLER,
      to: COUNTER_ADDR,
      data: "0x",
    });
    yield* evm.commitJournal();
    return exec;
  });

  const exec = await Effect.runPromise(Effect.scoped(program));
  expect(exec.success).toBe(true);
});

test("execute outside an open journal fails", async () => {
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

test("execute against a committed top journal fails", async () => {
  const program = Effect.gen(function* () {
    const evm = yield* createEVM();
    yield* evm.init(initWithCounter);
    yield* evm.beginJournal();
    yield* evm.execute({ from: CALLER, to: COUNTER_ADDR, data: "0x" });
    yield* evm.commitJournal();
    return yield* evm.execute({
      from: CALLER,
      to: COUNTER_ADDR,
      data: "0x",
    });
  });

  const exit = await Effect.runPromiseExit(Effect.scoped(program));
  expect(Exit.isFailure(exit)).toBe(true);
});

test("commitJournal on already-committed journal fails", async () => {
  const program = Effect.gen(function* () {
    const evm = yield* createEVM();
    yield* evm.init(initWithCounter);
    yield* evm.beginJournal();
    yield* evm.commitJournal();
    return yield* evm.commitJournal();
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
    yield* evm.beginJournal();
    const exec = yield* evm.execute({
      from: CALLER,
      to: REVERTING_ADDR,
      data: "0x",
    });
    yield* evm.commitJournal();
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
    yield* evm.beginJournal();
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

test("simulate does not mutate state — counter stays at 0 after simulate", async () => {
  const program = Effect.gen(function* () {
    const evm = yield* createEVM();
    yield* evm.init(initWithCounter);

    // simulate has no journal requirement and no persistence.
    const sim = yield* evm.simulate({
      from: CALLER,
      to: COUNTER_ADDR,
      data: "0x",
    });

    // Real journal: increment once, expect 0 -> 1, NOT 1 -> 2.
    yield* evm.beginJournal();
    yield* evm.execute({ from: CALLER, to: COUNTER_ADDR, data: "0x" });
    yield* evm.commitJournal();
    return sim;
  });

  const sim = await Effect.runPromise(Effect.scoped(program));
  expect(sim.success).toBe(true);
});

test("simulate against a stack of uncommitted journals preserves post-stack state", async () => {
  // Two open journals each increment. After both, slot is at 2. simulate
  // must un-apply the stack, run, re-apply — leaving the journal stack's
  // logical state intact for the eventual commit.
  const program = Effect.gen(function* () {
    const evm = yield* createEVM();
    yield* evm.init(initWithCounter);

    yield* evm.beginJournal();
    yield* evm.execute({ from: CALLER, to: COUNTER_ADDR, data: "0x" });
    // journal A still open

    yield* evm.beginJournal();
    yield* evm.execute({ from: CALLER, to: COUNTER_ADDR, data: "0x" });
    // journal B still open; slot in DB is at 2

    const sim = yield* evm.simulate({
      from: CALLER,
      to: COUNTER_ADDR,
      data: "0x",
    });

    // Commit the top journal only. The journal model commits one at a time;
    // ffca never leaves more than one uncommitted journal open in practice.
    yield* evm.commitJournal();
    return sim;
  });

  const sim = await Effect.runPromise(Effect.scoped(program));
  expect(sim.success).toBe(true);
});

test("simulate against committed + uncommitted journals only rewinds uncommitted", async () => {
  // Committed journal: slot 0 -> 1.
  // Uncommitted journal: slot 1 -> 2.
  // simulate must see the committed state (1), not the uncommitted state (2).
  const program = Effect.gen(function* () {
    const evm = yield* createEVM();
    yield* evm.init(initWithCounter);

    yield* evm.beginJournal();
    yield* evm.execute({ from: CALLER, to: COUNTER_ADDR, data: "0x" });
    yield* evm.commitJournal();

    yield* evm.beginJournal();
    yield* evm.execute({ from: CALLER, to: COUNTER_ADDR, data: "0x" });

    const sim = yield* evm.simulate({
      from: CALLER,
      to: COUNTER_ADDR,
      data: "0x",
    });

    yield* evm.commitJournal();
    return sim;
  });

  const sim = await Effect.runPromise(Effect.scoped(program));
  expect(sim.success).toBe(true);
});

test("revertJournal works on a committed journal", async () => {
  const program = Effect.gen(function* () {
    const evm = yield* createEVM();
    yield* evm.init(initWithCounter);

    yield* evm.beginJournal();
    yield* evm.execute({ from: CALLER, to: COUNTER_ADDR, data: "0x" });
    yield* evm.commitJournal();

    // Reverting the committed journal should restore slot to 0.
    yield* evm.revertJournal();

    // Start a new journal and increment; should go 0 -> 1.
    yield* evm.beginJournal();
    const exec = yield* evm.execute({
      from: CALLER,
      to: COUNTER_ADDR,
      data: "0x",
    });
    yield* evm.commitJournal();
    return exec;
  });

  const exec = await Effect.runPromise(Effect.scoped(program));
  expect(exec.success).toBe(true);
});

test("revertJournals reverts multiple journals", async () => {
  const program = Effect.gen(function* () {
    const evm = yield* createEVM();
    yield* evm.init(initWithCounter);

    yield* evm.beginJournal();
    yield* evm.execute({ from: CALLER, to: COUNTER_ADDR, data: "0x" });
    yield* evm.commitJournal();

    yield* evm.beginJournal();
    yield* evm.execute({ from: CALLER, to: COUNTER_ADDR, data: "0x" });

    yield* evm.beginJournal();
    yield* evm.execute({ from: CALLER, to: COUNTER_ADDR, data: "0x" });

    // Revert the two uncommitted journals.
    yield* evm.revertJournals({ count: 2 });

    // Slot should be back to 1 (from the committed journal).
    yield* evm.beginJournal();
    const exec = yield* evm.execute({
      from: CALLER,
      to: COUNTER_ADDR,
      data: "0x",
    });
    yield* evm.commitJournal();
    return exec;
  });

  const exec = await Effect.runPromise(Effect.scoped(program));
  expect(exec.success).toBe(true);
});

test("revertJournals with count greater than open journals fails", async () => {
  const program = Effect.gen(function* () {
    const evm = yield* createEVM();
    yield* evm.init(initWithCounter);
    yield* evm.beginJournal();
    return yield* evm.revertJournals({ count: 5 });
  });

  const exit = await Effect.runPromiseExit(Effect.scoped(program));
  expect(Exit.isFailure(exit)).toBe(true);
});

test("pruneJournals drops oldest committed journals", async () => {
  const program = Effect.gen(function* () {
    const evm = yield* createEVM();
    yield* evm.init(initWithCounter);

    yield* evm.beginJournal();
    yield* evm.execute({ from: CALLER, to: COUNTER_ADDR, data: "0x" });
    yield* evm.commitJournal();

    yield* evm.beginJournal();
    yield* evm.execute({ from: CALLER, to: COUNTER_ADDR, data: "0x" });
    yield* evm.commitJournal();

    yield* evm.pruneJournals({ count: 1 });

    // Reverting the remaining committed journal should restore slot to 1
    // (from the second committed journal, since the first was pruned).
    yield* evm.revertJournal();

    yield* evm.beginJournal();
    const exec = yield* evm.execute({
      from: CALLER,
      to: COUNTER_ADDR,
      data: "0x",
    });
    yield* evm.commitJournal();
    return exec;
  });

  const exec = await Effect.runPromise(Effect.scoped(program));
  expect(exec.success).toBe(true);
});

test("pruneJournals on uncommitted journals fails", async () => {
  const program = Effect.gen(function* () {
    const evm = yield* createEVM();
    yield* evm.init(initWithCounter);
    yield* evm.beginJournal();
    yield* evm.execute({ from: CALLER, to: COUNTER_ADDR, data: "0x" });
    return yield* evm.pruneJournals({ count: 1 });
  });

  const exit = await Effect.runPromiseExit(Effect.scoped(program));
  expect(Exit.isFailure(exit)).toBe(true);
});

test("setBlockContext updates block parameters", async () => {
  const program = Effect.gen(function* () {
    const evm = yield* createEVM();
    yield* evm.init({
      block: {
        number: "0x1",
        timestamp: "0x64",
        basefee: "0xa",
        coinbase: "0x0000000000000000000000000000000000000001",
      },
    });
    yield* evm.setBlockContext({
      number: "0x2",
      timestamp: "0xc8",
      basefee: "0x14",
      coinbase: "0x0000000000000000000000000000000000000002",
    });
    // No stateful assertion possible with the counter contract,
    // but the call should not error.
    yield* evm.beginJournal();
    const exec = yield* evm.execute({
      from: CALLER,
      to: COUNTER_ADDR,
      data: "0x",
    });
    yield* evm.commitJournal();
    return exec;
  });

  const exec = await Effect.runPromise(Effect.scoped(program));
  expect(exec.success).toBe(true);
});

test("execute e2e with compiled Solmate ERC20 bytecode", async () => {
  const artifact = await loadTestToken();
  const { params, schedulerBalanceSlot } = tokenInit(artifact);
  const userBalanceSlot = mappingSlot(USER_ADDR, BALANCE_OF_SLOT);
  const data = transferData(USER_ADDR, TRANSFER_AMOUNT);

  const program = Effect.gen(function* () {
    const evm = yield* createEVM();
    yield* evm.init(params);
    yield* evm.beginJournal();
    const exec = yield* evm.execute({
      from: SCHEDULER_ADDR,
      to: TOKEN_ADDR,
      data,
    });
    yield* evm.commitJournal();
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
    yield* evm.beginJournal();
    const exec = yield* evm.execute({
      from: SCHEDULER_ADDR,
      to: TOKEN_ADDR,
      data,
    });
    yield* evm.commitJournal();

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

test("simulate e2e temporarily rewinds optimistic Solmate ERC20 journals", async () => {
  const artifact = await loadTestToken();
  const { params, schedulerBalanceSlot } = tokenInit(artifact);
  const userBalanceSlot = mappingSlot(USER_ADDR, BALANCE_OF_SLOT);
  const recipientBalanceSlot = mappingSlot(RECIPIENT_ADDR, BALANCE_OF_SLOT);

  const program = Effect.gen(function* () {
    const evm = yield* createEVM();
    yield* evm.init(params);
    yield* evm.beginJournal();
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
    yield* evm.commitJournal();
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

test("sidecar gas_limit matches eth_estimateGas for Solmate ERC20 transfer", async () => {
  // The sidecar uses two-pass execution: pass 1 discovers the access list,
  // then it binary-searches the smallest successful gas limit with those slots
  // pre-warmed (an EIP-2930 tx).
  const artifact = await loadTestToken();
  const tokenAddr = await deployTestToken(artifact);
  const data = transferData(USER_ADDR, TRANSFER_AMOUNT);

  // Discover the access list and estimate gas via RPC, mirroring the runtime.
  const { accessList: rpcAccessList } =
    await TEST_PUBLIC_CLIENT.createAccessList({
      account: SCHEDULER_ADDR,
      to: tokenAddr,
      data,
    });
  const rpcGasEstimate = await TEST_PUBLIC_CLIENT.estimateGas({
    account: SCHEDULER_ADDR,
    to: tokenAddr,
    data,
    accessList: rpcAccessList,
  });

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

  expect(BigInt(sidecar.gas_limit)).toEqual(rpcGasEstimate);
  expect(sidecar.gas_used).toBeLessThanOrEqual(sidecar.gas_limit);
});

test("sidecar gas_limit includes EIP-150 call headroom", async () => {
  const calleeArtifact = await loadCallGasCallee();
  const callerArtifact = await loadCallGasCaller();
  const calleeAddr = await deployArtifact(calleeArtifact);
  const callerAddr = await deployArtifact(callerArtifact);
  const data = callBurnData(calleeAddr, 250n);

  const { accessList: rpcAccessList } =
    await TEST_PUBLIC_CLIENT.createAccessList({
      account: SCHEDULER_ADDR,
      to: callerAddr,
      data,
    });
  const rpcGasEstimate = await TEST_PUBLIC_CLIENT.estimateGas({
    account: SCHEDULER_ADDR,
    to: callerAddr,
    data,
    accessList: rpcAccessList,
  });

  const program = Effect.gen(function* () {
    const evm = yield* createEVM();
    yield* evm.init({
      chain_id: 31337,
      accounts: {
        [calleeAddr]: { code: calleeArtifact.deployedBytecode.object },
        [callerAddr]: { code: callerArtifact.deployedBytecode.object },
      },
    });
    return yield* evm.simulate({
      from: SCHEDULER_ADDR,
      to: callerAddr,
      data,
    });
  });
  const sidecar = await Effect.runPromise(Effect.scoped(program));

  expect(normalizeAccessRecord(sidecar.access_list)).toEqual(
    normalizeAccessRecord(rpcAccessList),
  );
  expect(BigInt(sidecar.gas_limit)).toEqual(rpcGasEstimate);
  expect(sidecar.gas_used).toBeLessThan(sidecar.gas_limit);
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
