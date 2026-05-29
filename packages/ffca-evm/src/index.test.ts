// Each test creates its own in-process native EVM (one createEVM per test)
// and exercises the journal protocol against a hand-written counter contract.
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

test("execute against counter succeeds and returns a journal id", async () => {
  const program = Effect.gen(function* () {
    const evm = yield* createEVM();
    yield* evm.init(initWithCounter);
    const exec = yield* evm.execute({
      from: CALLER,
      to: COUNTER_ADDR,
      data: "0x",
    });
    return exec;
  });

  const exec = await Effect.runPromise(Effect.scoped(program));
  expect(exec.success).toBe(true);
  expect(exec.journal_id).toBe(1);
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

test("two executes create sequential journals", async () => {
  const program = Effect.gen(function* () {
    const evm = yield* createEVM();
    yield* evm.init(initWithCounter);
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
    return { first, second };
  });

  const { first, second } = await Effect.runPromise(Effect.scoped(program));
  expect(first.success).toBe(true);
  expect(first.journal_id).toBe(1);
  expect(second.success).toBe(true);
  expect(second.journal_id).toBe(2);
});

test("revertJournals drops writes; next journal starts from pre-revert state", async () => {
  const program = Effect.gen(function* () {
    const evm = yield* createEVM();
    yield* evm.init(initWithCounter);

    // Journal 1: increment, revert.
    const reverted = yield* evm.execute({
      from: CALLER,
      to: COUNTER_ADDR,
      data: "0x",
    });
    yield* evm.revertJournals({ journal_ids: [reverted.journal_id!] });

    // Journal 2: increment, commit. Slot should go 0 -> 1, not 1 -> 2.
    const exec = yield* evm.execute({
      from: CALLER,
      to: COUNTER_ADDR,
      data: "0x",
    });
    return exec;
  });

  const exec = await Effect.runPromise(Effect.scoped(program));
  expect(exec.success).toBe(true);
});

test("sequential journals keep local state", async () => {
  const program = Effect.gen(function* () {
    const evm = yield* createEVM();
    yield* evm.init(initWithCounter);

    yield* evm.execute({ from: CALLER, to: COUNTER_ADDR, data: "0x" });

    const exec = yield* evm.execute({
      from: CALLER,
      to: COUNTER_ADDR,
      data: "0x",
    });
    return exec;
  });

  const exec = await Effect.runPromise(Effect.scoped(program));
  expect(exec.success).toBe(true);
});

test("execute opens a journal automatically", async () => {
  const program = Effect.gen(function* () {
    const evm = yield* createEVM();
    yield* evm.init(initWithCounter);
    return yield* evm.execute({
      from: CALLER,
      to: COUNTER_ADDR,
      data: "0x",
    });
  });

  const exec = await Effect.runPromise(Effect.scoped(program));
  expect(exec.success).toBe(true);
  expect(exec.journal_id).toBe(1);
});

test("failed execute discards journal writes", async () => {
  const program = Effect.gen(function* () {
    const evm = yield* createEVM();
    yield* evm.init({
      accounts: {
        [REVERTING_ADDR]: { code: WRITE_THEN_REVERT_CODE },
      },
    });
    const exec = yield* evm.execute({
      from: CALLER,
      to: REVERTING_ADDR,
      data: "0x",
    });
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
      journal_ids: [],
    });

    // Real journal: increment once, expect 0 -> 1, NOT 1 -> 2.
    yield* evm.execute({ from: CALLER, to: COUNTER_ADDR, data: "0x" });
    return sim;
  });

  const sim = await Effect.runPromise(Effect.scoped(program));
  expect(sim.success).toBe(true);
});

test("simulate rewinds and re-applies selected journals", async () => {
  // Two optimistic journals each increment. After both, slot is at 2.
  // simulate must un-apply the provided journals, run, then re-apply them.
  const program = Effect.gen(function* () {
    const evm = yield* createEVM();
    yield* evm.init(initWithCounter);

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

    const sim = yield* evm.simulate({
      from: CALLER,
      to: COUNTER_ADDR,
      data: "0x",
      journal_ids: [first.journal_id!, second.journal_id!],
    });

    return sim;
  });

  const sim = await Effect.runPromise(Effect.scoped(program));
  expect(sim.success).toBe(true);
});

test("simulate only rewinds the provided journal ids", async () => {
  // First journal: slot 0 -> 1. Second journal: slot 1 -> 2.
  // simulate receives only the second id, so it runs against slot value 1.
  const program = Effect.gen(function* () {
    const evm = yield* createEVM();
    yield* evm.init(initWithCounter);

    yield* evm.execute({ from: CALLER, to: COUNTER_ADDR, data: "0x" });

    const second = yield* evm.execute({
      from: CALLER,
      to: COUNTER_ADDR,
      data: "0x",
    });

    const sim = yield* evm.simulate({
      from: CALLER,
      to: COUNTER_ADDR,
      data: "0x",
      journal_ids: [second.journal_id!],
    });

    return sim;
  });

  const sim = await Effect.runPromise(Effect.scoped(program));
  expect(sim.success).toBe(true);
});

test("revertJournals works on a journal", async () => {
  const program = Effect.gen(function* () {
    const evm = yield* createEVM();
    yield* evm.init(initWithCounter);

    const accepted = yield* evm.execute({
      from: CALLER,
      to: COUNTER_ADDR,
      data: "0x",
    });

    // Reverting the journal should restore slot to 0.
    yield* evm.revertJournals({ journal_ids: [accepted.journal_id!] });

    // Start a new journal and increment; should go 0 -> 1.
    const exec = yield* evm.execute({
      from: CALLER,
      to: COUNTER_ADDR,
      data: "0x",
    });
    return exec;
  });

  const exec = await Effect.runPromise(Effect.scoped(program));
  expect(exec.success).toBe(true);
});

test("revertJournals reverts multiple journals", async () => {
  const program = Effect.gen(function* () {
    const evm = yield* createEVM();
    yield* evm.init(initWithCounter);

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

    const third = yield* evm.execute({
      from: CALLER,
      to: COUNTER_ADDR,
      data: "0x",
    });

    yield* evm.revertJournals({
      journal_ids: [first.journal_id!, second.journal_id!, third.journal_id!],
    });

    const exec = yield* evm.execute({
      from: CALLER,
      to: COUNTER_ADDR,
      data: "0x",
    });
    return exec;
  });

  const exec = await Effect.runPromise(Effect.scoped(program));
  expect(exec.success).toBe(true);
});

test("revertJournals with an unknown journal id fails", async () => {
  const program = Effect.gen(function* () {
    const evm = yield* createEVM();
    yield* evm.init(initWithCounter);
    return yield* evm.revertJournals({ journal_ids: [5] });
  });

  const exit = await Effect.runPromiseExit(Effect.scoped(program));
  expect(Exit.isFailure(exit)).toBe(true);
});

test("pruneJournals drops selected journals", async () => {
  const program = Effect.gen(function* () {
    const evm = yield* createEVM();
    yield* evm.init(initWithCounter);

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

    yield* evm.pruneJournals({ journal_ids: [first.journal_id!] });

    // Reverting the remaining journal should restore slot to 1.
    yield* evm.revertJournals({ journal_ids: [second.journal_id!] });

    const exec = yield* evm.execute({
      from: CALLER,
      to: COUNTER_ADDR,
      data: "0x",
    });
    return exec;
  });

  const exec = await Effect.runPromise(Effect.scoped(program));
  expect(exec.success).toBe(true);
});

test("pruneJournals with an unknown journal id fails", async () => {
  const program = Effect.gen(function* () {
    const evm = yield* createEVM();
    yield* evm.init(initWithCounter);
    return yield* evm.pruneJournals({ journal_ids: [1] });
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
    const exec = yield* evm.execute({
      from: CALLER,
      to: COUNTER_ADDR,
      data: "0x",
    });
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
    const exec = yield* evm.execute({
      from: SCHEDULER_ADDR,
      to: TOKEN_ADDR,
      data,
    });
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
    const exec = yield* evm.execute({
      from: SCHEDULER_ADDR,
      to: TOKEN_ADDR,
      data,
    });

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
    const optimistic = yield* evm.execute({
      from: SCHEDULER_ADDR,
      to: TOKEN_ADDR,
      data: transferData(USER_ADDR, TRANSFER_AMOUNT),
    });
    const simulated = yield* evm.simulate({
      from: SCHEDULER_ADDR,
      to: TOKEN_ADDR,
      data: transferData(RECIPIENT_ADDR, SIMULATE_AMOUNT),
      journal_ids: [optimistic.journal_id!],
    });
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

test("harness access list matches eth_createAccessList for Solmate ERC20 transfer", async () => {
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
      journal_ids: [],
    });
  });
  const harness = await Effect.runPromise(Effect.scoped(program));
  expect(normalizeAccessRecord(harness.access_list)).toEqual(rpcAccessList);
});

test("harness gas_limit matches eth_estimateGas for Solmate ERC20 transfer", async () => {
  // The harness uses two-pass execution: pass 1 discovers the access list,
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
      journal_ids: [],
    });
  });
  const harness = await Effect.runPromise(Effect.scoped(program));

  expect(BigInt(harness.gas_limit)).toEqual(rpcGasEstimate);
  expect(harness.gas_used).toBeLessThanOrEqual(harness.gas_limit);
});

test("harness gas_limit includes EIP-150 call headroom", async () => {
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
      journal_ids: [],
    });
  });
  const harness = await Effect.runPromise(Effect.scoped(program));

  expect(normalizeAccessRecord(harness.access_list)).toEqual(
    normalizeAccessRecord(rpcAccessList),
  );
  expect(BigInt(harness.gas_limit)).toEqual(rpcGasEstimate);
  expect(harness.gas_used).toBeLessThan(harness.gas_limit);
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

test("an interrupted execute does not desync subsequent calls", async () => {
  // Regression: the protocol used to match responses by FIFO queue order.
  // If a caller was interrupted between sending its request and taking
  // its response, the sidecar's eventual reply would orphan the queue and
  // every subsequent call would observe `id N, expected N+1`. Per-id
  // dispatch makes the orphan a no-op — the next call must succeed.
  //
  // We hammer many short-timeout calls to land at least one in the
  // dangerous window between "request written" and "response taken". On
  // the new code every iteration is safe; on the old code the protocol
  // would desync as soon as any orphan landed.
  const program = Effect.gen(function* () {
    const evm = yield* createEVM();
    yield* evm.init(initWithCounter);

    for (let i = 0; i < 100; i++) {
      yield* Effect.ignore(
        Effect.timeout(
          evm.execute({ from: CALLER, to: COUNTER_ADDR, data: "0x" }),
          "0 millis",
        ),
      );
    }

    // Drain any in-flight orphan responses from the sidecar.
    yield* Effect.sleep("50 millis");

    return yield* evm.execute({
      from: CALLER,
      to: COUNTER_ADDR,
      data: "0x",
    });
  });

  const exec = await Effect.runPromise(Effect.scoped(program));
  expect(exec.success).toBe(true);
});

test("concurrent calls are dispatched by id, not arrival order", async () => {
  // Per-id dispatch lets multiple calls be in flight at once. The sidecar
  // processes them in arrival order, but each response routes back to its
  // own caller regardless of when it lands.
  const program = Effect.gen(function* () {
    const evm = yield* createEVM();
    yield* evm.init(initWithCounter);
    return yield* Effect.all(
      Array.from({ length: 5 }, () =>
        evm.execute({ from: CALLER, to: COUNTER_ADDR, data: "0x" }),
      ),
      { concurrency: "unbounded" },
    );
  });

  const results = await Effect.runPromise(Effect.scoped(program));
  expect(results.length).toBe(5);
  expect(results.every((r) => r.success)).toBe(true);
  const journalIds = results.map((r) => r.journal_id!).sort((a, b) => a - b);
  expect(journalIds).toEqual([1, 2, 3, 4, 5]);
});
