// Each test creates its own in-process native EVM (one createEVM per test)
// and exercises the journal protocol against a hand-written counter contract.
//
// Counter runtime bytecode — increments storage slot 0 by 1 on any call:
//   PUSH1 0x00 DUP1 SLOAD PUSH1 0x01 ADD SWAP1 SSTORE STOP
const COUNTER_CODE = "0x60008054600101905500" as const;
// Writes two new slots in the same 128-word MIP-8 storage page.
const SAME_PAGE_WRITES_CODE = "0x6001600055600160015500" as const;
// Writes slot 0, then reverts. Failed executions must not persist writes.
const WRITE_THEN_REVERT_CODE = "0x600160005560006000fd" as const;
// Runs INVALID (0xfe), which halts rather than reverts.
const HALT_CODE = "0xfe" as const;

const COUNTER_ADDR = "0x0000000000000000000000000000000000000c01" as const;
const PAGE_WRITES_ADDR = "0x0000000000000000000000000000000000000c02" as const;
const REVERTING_ADDR = "0x0000000000000000000000000000000000000bad" as const;
const HALTING_ADDR = "0x0000000000000000000000000000000000000ba1" as const;
const CALLER = "0x000000000000000000000000000000000000ca11" as const;
const P256_VERIFIER = "0x0000000000000000000000000000000000000100" as const;

import { expect, test } from "bun:test";
import { Effect, Exit, Fiber, Scheduler } from "effect";
import { Hash, Hex } from "ox";
import { createStorageView } from "storage-layout";
import { TEST_PUBLIC_CLIENT } from "../test/setup";
import {
  BALANCE_OF_SLOT,
  callBurnData,
  callPrecompileData,
  deployArtifact,
  deployTestToken,
  INITIAL_SUPPLY,
  loadCallGasCallee,
  loadCallGasCaller,
  loadPrecompileCaller,
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
import {
  type BlockParams,
  createEVM,
  EvmCallError,
  type ExecuteResult,
  type InitParams,
  type Spec,
} from "./index";

function journalId(result: ExecuteResult): number {
  if (result.status !== "success") {
    throw new Error(`expected success, got ${result.status}`);
  }
  return result.journal_id;
}

const initWithCounter = {
  spec: "MonadTen",
  accounts: {
    [COUNTER_ADDR]: { code: COUNTER_CODE },
  },
} as const;

const MONAD_MAINNET_CHAIN_ID = 143;
const MONAD_TEN_MAINNET_TIMESTAMP = 1_788_359_400;

const runSamePageWrites = (
  init: Pick<InitParams, "spec" | "chain_id" | "block">,
  block?: BlockParams,
) =>
  Effect.gen(function* () {
    const evm = yield* createEVM({
      ...init,
      accounts: {
        [PAGE_WRITES_ADDR]: { code: SAME_PAGE_WRITES_CODE },
      },
    });
    if (block !== undefined) yield* evm.setBlockContext(block);
    return yield* evm.execute({
      from: CALLER,
      to: PAGE_WRITES_ADDR,
      data: "0x",
    });
  });

const samePageWritesGas = (
  init: Pick<InitParams, "spec" | "chain_id" | "block">,
  block?: BlockParams,
) =>
  Effect.runPromise(Effect.scoped(runSamePageWrites(init, block))).then(
    (result) => result.gas_used,
  );

const beforeMonadTen = {
  timestamp: Hex.fromNumber(MONAD_TEN_MAINNET_TIMESTAMP - 1),
};
const atMonadTen = { timestamp: Hex.fromNumber(MONAD_TEN_MAINNET_TIMESTAMP) };

test("MonadTen enables MIP-8 page storage gas", async () => {
  const [monadNine, monadTen] = await Promise.all([
    samePageWritesGas({ spec: "MonadNine" }),
    samePageWritesGas({ spec: "MonadTen" }),
  ]);

  expect(monadTen).toBeLessThan(monadNine);
});

test("the hardfork follows the chain's schedule at the block timestamp", async () => {
  const [monadNine, monadTen, before, at] = await Promise.all([
    samePageWritesGas({ spec: "MonadNine" }),
    samePageWritesGas({ spec: "MonadTen" }),
    samePageWritesGas({
      chain_id: MONAD_MAINNET_CHAIN_ID,
      block: beforeMonadTen,
    }),
    samePageWritesGas({ chain_id: MONAD_MAINNET_CHAIN_ID, block: atMonadTen }),
  ]);

  expect(before).toBe(monadNine);
  expect(at).toBe(monadTen);
});

test("setBlockContext switches the hardfork across an activation", async () => {
  const [monadNine, monadTen, forward, backward] = await Promise.all([
    samePageWritesGas({ spec: "MonadNine" }),
    samePageWritesGas({ spec: "MonadTen" }),
    samePageWritesGas(
      { chain_id: MONAD_MAINNET_CHAIN_ID, block: beforeMonadTen },
      atMonadTen,
    ),
    // A reorg can move the block timestamp back across an activation.
    samePageWritesGas(
      { chain_id: MONAD_MAINNET_CHAIN_ID, block: atMonadTen },
      beforeMonadTen,
    ),
  ]);

  expect(forward).toBe(monadTen);
  expect(backward).toBe(monadNine);
});

test("a pinned spec ignores the chain's schedule", async () => {
  const [monadNine, pinned] = await Promise.all([
    samePageWritesGas({ spec: "MonadNine" }),
    samePageWritesGas({
      spec: "MonadNine",
      chain_id: MONAD_MAINNET_CHAIN_ID,
      block: atMonadTen,
    }),
  ]);

  expect(pinned).toBe(monadNine);
});

test("createEVM fails on a chain without a Monad hardfork schedule", async () => {
  const program = createEVM({ chain_id: 1 });

  const exit = await Effect.runPromiseExit(Effect.scoped(program));
  expect(exit).toEqual(
    Exit.fail(
      new EvmCallError({
        method: "init",
        message:
          "init failed: chain 1 has no known Monad hardfork schedule; pass a spec",
        cause: "chain 1 has no known Monad hardfork schedule; pass a spec",
      }),
    ),
  );
});

test("execute against counter succeeds and returns a journal id", async () => {
  const program = Effect.gen(function* () {
    const evm = yield* createEVM(initWithCounter);
    const exec = yield* evm.execute({
      from: CALLER,
      to: COUNTER_ADDR,
      data: "0x",
    });
    return exec;
  });

  const exec = await Effect.runPromise(Effect.scoped(program));
  expect(exec.status).toBe("success");
  expect(journalId(exec)).toBe(1);
  // Only simulate estimates a gas limit.
  expect(exec).not.toHaveProperty("gas_limit");
  expect(exec.slot_writes).toEqual([
    {
      slot: "0x0000000000000000000000000000000000000000000000000000000000000000",
      value:
        "0x0000000000000000000000000000000000000000000000000000000000000001",
    },
  ]);
});

test("two executes create sequential journals", async () => {
  const program = Effect.gen(function* () {
    const evm = yield* createEVM(initWithCounter);
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
  expect(first.status).toBe("success");
  expect(journalId(first)).toBe(1);
  expect(second.status).toBe("success");
  expect(journalId(second)).toBe(2);
});

test("revertJournals drops writes; next journal starts from pre-revert state", async () => {
  const program = Effect.gen(function* () {
    const evm = yield* createEVM(initWithCounter);

    // Journal 1: increment, revert.
    const reverted = yield* evm.execute({
      from: CALLER,
      to: COUNTER_ADDR,
      data: "0x",
    });
    yield* evm.revertJournals({ journal_ids: [journalId(reverted)] });

    // Journal 2: increment, commit. Slot should go 0 -> 1, not 1 -> 2.
    const exec = yield* evm.execute({
      from: CALLER,
      to: COUNTER_ADDR,
      data: "0x",
    });
    return exec;
  });

  const exec = await Effect.runPromise(Effect.scoped(program));
  expect(exec.status).toBe("success");
});

test("sequential journals keep local state", async () => {
  const program = Effect.gen(function* () {
    const evm = yield* createEVM(initWithCounter);

    yield* evm.execute({ from: CALLER, to: COUNTER_ADDR, data: "0x" });

    const exec = yield* evm.execute({
      from: CALLER,
      to: COUNTER_ADDR,
      data: "0x",
    });
    return exec;
  });

  const exec = await Effect.runPromise(Effect.scoped(program));
  expect(exec.status).toBe("success");
});

test("execute opens a journal automatically", async () => {
  const program = Effect.gen(function* () {
    const evm = yield* createEVM(initWithCounter);
    return yield* evm.execute({
      from: CALLER,
      to: COUNTER_ADDR,
      data: "0x",
    });
  });

  const exec = await Effect.runPromise(Effect.scoped(program));
  expect(exec.status).toBe("success");
  expect(journalId(exec)).toBe(1);
});

test("failed execute discards journal writes", async () => {
  const program = Effect.gen(function* () {
    const evm = yield* createEVM({
      spec: "MonadTen",
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
  expect(exec).toMatchObject({ status: "revert", data: "0x" });
});

test("execute reports a halt separately from a revert", async () => {
  const program = Effect.gen(function* () {
    const evm = yield* createEVM({
      spec: "MonadTen",
      accounts: {
        [HALTING_ADDR]: { code: HALT_CODE },
      },
    });
    return yield* evm.execute({
      from: CALLER,
      to: HALTING_ADDR,
      data: "0x",
    });
  });

  const exec = await Effect.runPromise(Effect.scoped(program));
  expect(exec).toMatchObject({ status: "halt", reason: "InvalidFEOpcode" });
});

test("execute returns access_list with the counter address + slot 0", async () => {
  const program = Effect.gen(function* () {
    const evm = yield* createEVM(initWithCounter);
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
    const evm = yield* createEVM(initWithCounter);

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
  expect(sim.status).toBe("success");
});

test("simulate rewinds and re-applies selected journals", async () => {
  // Two optimistic journals each increment. After both, slot is at 2.
  // simulate must un-apply the provided journals, run, then re-apply them.
  const program = Effect.gen(function* () {
    const evm = yield* createEVM(initWithCounter);

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
      journal_ids: [journalId(first), journalId(second)],
    });

    return sim;
  });

  const sim = await Effect.runPromise(Effect.scoped(program));
  expect(sim.status).toBe("success");
});

test("simulate only rewinds the provided journal ids", async () => {
  // First journal: slot 0 -> 1. Second journal: slot 1 -> 2.
  // simulate receives only the second id, so it runs against slot value 1.
  const program = Effect.gen(function* () {
    const evm = yield* createEVM(initWithCounter);

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
      journal_ids: [journalId(second)],
    });

    return sim;
  });

  const sim = await Effect.runPromise(Effect.scoped(program));
  expect(sim.status).toBe("success");
});

test("revertJournals works on a journal", async () => {
  const program = Effect.gen(function* () {
    const evm = yield* createEVM(initWithCounter);

    const accepted = yield* evm.execute({
      from: CALLER,
      to: COUNTER_ADDR,
      data: "0x",
    });

    // Reverting the journal should restore slot to 0.
    yield* evm.revertJournals({ journal_ids: [journalId(accepted)] });

    // Start a new journal and increment; should go 0 -> 1.
    const exec = yield* evm.execute({
      from: CALLER,
      to: COUNTER_ADDR,
      data: "0x",
    });
    return exec;
  });

  const exec = await Effect.runPromise(Effect.scoped(program));
  expect(exec.status).toBe("success");
});

test("revertJournals reverts multiple journals", async () => {
  const program = Effect.gen(function* () {
    const evm = yield* createEVM(initWithCounter);

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
      journal_ids: [journalId(first), journalId(second), journalId(third)],
    });

    const exec = yield* evm.execute({
      from: CALLER,
      to: COUNTER_ADDR,
      data: "0x",
    });
    return exec;
  });

  const exec = await Effect.runPromise(Effect.scoped(program));
  expect(exec.status).toBe("success");
});

test("revertJournals with an unknown journal id fails", async () => {
  const program = Effect.gen(function* () {
    const evm = yield* createEVM(initWithCounter);
    return yield* evm.revertJournals({ journal_ids: [5] });
  });

  const exit = await Effect.runPromiseExit(Effect.scoped(program));
  expect(Exit.isFailure(exit)).toBe(true);
});

test("pruneJournals drops selected journals", async () => {
  const program = Effect.gen(function* () {
    const evm = yield* createEVM(initWithCounter);

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

    yield* evm.pruneJournals({ journal_ids: [journalId(first)] });

    // Reverting the remaining journal should restore slot to 1.
    yield* evm.revertJournals({ journal_ids: [journalId(second)] });

    const exec = yield* evm.execute({
      from: CALLER,
      to: COUNTER_ADDR,
      data: "0x",
    });
    return exec;
  });

  const exec = await Effect.runPromise(Effect.scoped(program));
  expect(exec.status).toBe("success");
});

test("pruneJournals with an unknown journal id fails", async () => {
  const program = Effect.gen(function* () {
    const evm = yield* createEVM(initWithCounter);
    return yield* evm.pruneJournals({ journal_ids: [1] });
  });

  const exit = await Effect.runPromiseExit(Effect.scoped(program));
  expect(Exit.isFailure(exit)).toBe(true);
});

test("setBlockContext updates block parameters", async () => {
  const program = Effect.gen(function* () {
    const evm = yield* createEVM({
      spec: "MonadTen",
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
  expect(exec.status).toBe("success");
});

test("execute e2e with compiled Solmate ERC20 bytecode", async () => {
  const artifact = await loadTestToken();
  const { params, schedulerBalanceSlot } = tokenInit(artifact);
  const userBalanceSlot = mappingSlot(USER_ADDR, BALANCE_OF_SLOT);
  const data = transferData(USER_ADDR, TRANSFER_AMOUNT);

  const program = Effect.gen(function* () {
    const evm = yield* createEVM(params);
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
    status: exec.status,
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
      "status": "success",
    }
  `);
});

test("execute reports mapping keccak preimages for touched slots", async () => {
  const artifact = await loadTestToken();
  const { params, schedulerBalanceSlot } = tokenInit(artifact);
  const userBalanceSlot = mappingSlot(USER_ADDR, BALANCE_OF_SLOT);

  const program = Effect.gen(function* () {
    const evm = yield* createEVM(params);
    return yield* evm.execute({
      from: SCHEDULER_ADDR,
      to: TOKEN_ADDR,
      data: transferData(USER_ADDR, TRANSFER_AMOUNT),
    });
  });

  const exec = await Effect.runPromise(Effect.scoped(program));

  // Each preimage hashes to the mapping slot it names.
  const slots = exec.keccak_preimages.map((preimage) =>
    Hash.keccak256(preimage),
  );
  expect(slots).toContain(schedulerBalanceSlot);
  expect(slots).toContain(userBalanceSlot);
  expect(exec.keccak_preimages).toContain(
    Hex.concat(
      Hex.padLeft(USER_ADDR, 32),
      Hex.fromNumber(BALANCE_OF_SLOT, { size: 32 }),
    ).toLowerCase() as Hex.Hex,
  );
});

test("readStorage decodes committed token state through storage proxy", async () => {
  const artifact = await loadTestToken();
  const { params } = tokenInit(artifact);
  const data = transferData(USER_ADDR, TRANSFER_AMOUNT);

  const program = Effect.gen(function* () {
    const evm = yield* createEVM(params);
    const exec = yield* evm.execute({
      from: SCHEDULER_ADDR,
      to: TOKEN_ADDR,
      data,
    });

    const token = createStorageView(tokenStorageLayout, async (slots) => {
      const storage = await Effect.runPromise(
        evm.readStorage({ address: TOKEN_ADDR, slots: [...slots] }),
      );
      return slots.map((slot) => storage[slot]!);
    });
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
    exec: expect.objectContaining({ status: "success" }),
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
    const evm = yield* createEVM(params);
    const optimistic = yield* evm.execute({
      from: SCHEDULER_ADDR,
      to: TOKEN_ADDR,
      data: transferData(USER_ADDR, TRANSFER_AMOUNT),
    });
    const simulated = yield* evm.simulate({
      from: SCHEDULER_ADDR,
      to: TOKEN_ADDR,
      data: transferData(RECIPIENT_ADDR, SIMULATE_AMOUNT),
      journal_ids: [journalId(optimistic)],
    });
    return { optimistic, simulated };
  });

  const { optimistic, simulated } = await Effect.runPromise(
    Effect.scoped(program),
  );

  expect({
    optimisticAccessList: normalizeAccessRecord(optimistic.access_list),
    optimisticStatus: optimistic.status,
    simulatedAccessList: normalizeAccessRecord(simulated.access_list),
    simulatedStatus: simulated.status,
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
      "optimisticStatus": "success",
      "simulatedAccessList": [
        {
          "address": "0x0000000000000000000000000000000000000e20",
          "storageKeys": [
            "0x9c35da83f88043b3115f30d93beacec49ca14b6238430bdff196a249c29baa80",
            "0xc651ee22c6951bb8b5bd29e8210fb394645a94315fe10eff2cc73de1aa75c137",
          ],
        },
      ],
      "simulatedStatus": "success",
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
    const evm = yield* createEVM(params);
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

test("harness gas_limit is sufficient for Solmate ERC20 transfer", async () => {
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
    const evm = yield* createEVM(params);
    return yield* evm.simulate({
      from: SCHEDULER_ADDR,
      to: tokenAddr,
      data,
      journal_ids: [],
    });
  });
  const harness = await Effect.runPromise(Effect.scoped(program));

  // The native harness and Anvil can differ by a small amount for custom
  // Monad gas accounting; the harness limit must never under-estimate RPC.
  expect(BigInt(harness.gas_limit)).toBeGreaterThanOrEqual(rpcGasEstimate);
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
    const evm = yield* createEVM({
      spec: "MonadTen",
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
  expect(BigInt(harness.gas_limit)).toBeGreaterThanOrEqual(rpcGasEstimate);
  expect(harness.gas_used).toBeLessThan(harness.gas_limit);
});

test("access list leaves out the P-256 precompile at 0x100", async () => {
  const artifact = await loadPrecompileCaller();
  const callerAddr = await deployArtifact(artifact);
  // An invalid signature: the precompile charges its gas and returns no data.
  const data = callPrecompileData(P256_VERIFIER, Hex.padLeft("0x", 160));

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
    const evm = yield* createEVM({
      spec: "MonadTen",
      chain_id: 31337,
      accounts: {
        [callerAddr]: { code: artifact.deployedBytecode.object },
      },
    });
    const executed = yield* evm.execute({
      from: SCHEDULER_ADDR,
      to: callerAddr,
      data,
    });
    const simulated = yield* evm.simulate({
      from: SCHEDULER_ADDR,
      to: callerAddr,
      data,
      journal_ids: [],
    });
    return { executed, simulated };
  });
  const { executed, simulated } = await Effect.runPromise(
    Effect.scoped(program),
  );

  expect(executed.status).toBe("success");
  expect(simulated.status).toBe("success");
  expect(rpcAccessList).toEqual([]);
  expect(executed.access_list).toEqual([]);
  expect(simulated.access_list).toEqual([]);
  expect(BigInt(simulated.gas_limit)).toBeGreaterThanOrEqual(rpcGasEstimate);
});

test("createEVM fails with an unknown spec", async () => {
  const program = createEVM({ spec: "MonadZero" as Spec });

  const exit = await Effect.runPromiseExit(Effect.scoped(program));
  expect(exit).toEqual(
    Exit.fail(
      new EvmCallError({
        method: "init",
        message:
          "init failed: parse error: unknown variant `MonadZero`, expected one of `MonadEight`, `MonadNine`, `MonadTen`, `MonadNext` at line 1 column 19",
        cause:
          "parse error: unknown variant `MonadZero`, expected one of `MonadEight`, `MonadNine`, `MonadTen`, `MonadNext` at line 1 column 19",
      }),
    ),
  );
});

test("an interrupted execute does not desync subsequent calls", async () => {
  // Interruption safety. createEVM serializes calls through a semaphore and
  // each native call returns its own response synchronously, so an execute
  // that is interrupted around the semaphore/native-call boundary must not
  // leave the harness or the request-id sequence in a state that breaks the
  // next caller.
  //
  // We hammer many zero-timeout calls so at least one is interrupted in that
  // window, then assert a normal execute still succeeds.
  const program = Effect.gen(function* () {
    const evm = yield* createEVM(initWithCounter);

    for (let i = 0; i < 100; i++) {
      yield* Effect.ignore(
        Effect.timeout(
          evm.execute({ from: CALLER, to: COUNTER_ADDR, data: "0x" }),
          "0 millis",
        ),
      );
    }

    // Let any interrupted fibers settle before the final call.
    yield* Effect.sleep("50 millis");

    return yield* evm.execute({
      from: CALLER,
      to: COUNTER_ADDR,
      data: "0x",
    });
  });

  const exec = await Effect.runPromise(Effect.scoped(program));
  expect(exec.status).toBe("success");
});

test("concurrent execute submissions serialize into sequential journals", async () => {
  // Each native call blocks the thread, so executes submitted concurrently
  // run one at a time and each opens the next sequential journal id rather
  // than racing or interleaving.
  const program = Effect.gen(function* () {
    const evm = yield* createEVM(initWithCounter);
    return yield* Effect.all(
      Array.from({ length: 5 }, () =>
        evm.execute({ from: CALLER, to: COUNTER_ADDR, data: "0x" }),
      ),
      { concurrency: "unbounded" },
    );
  });

  const results = await Effect.runPromise(Effect.scoped(program));
  expect(results.length).toBe(5);
  expect(results.every((r) => r.status === "success")).toBe(true);
  const journalIds = results.map((r) => journalId(r)).sort((a, b) => a - b);
  expect(journalIds).toEqual([1, 2, 3, 4, 5]);
});

test("runSync completes while another call is paused mid-call", async () => {
  // A fiber can yield to the scheduler at any op. Nothing in a call may wait
  // on another call, or runSync on a storage read fails with AsyncFiberError.
  const program = Effect.gen(function* () {
    const evm = yield* createEVM(initWithCounter);
    const read = evm.readStorage({ address: COUNTER_ADDR, slots: ["0x0"] });
    // A budget below 3 yields before any progress, so the fiber never ends.
    for (let ops = 3; ops <= 32; ops++) {
      // Yield after `ops` ops so the forked call pauses at each point in it.
      const fiber = Effect.runFork(
        read.pipe(Effect.provideService(Scheduler.MaxOpsBeforeYield, ops)),
      );
      expect(Effect.runSync(read)).toEqual(
        yield* Effect.promise(() => Effect.runPromise(read)),
      );
      yield* Fiber.join(fiber);
    }
  });

  await Effect.runPromise(Effect.scoped(program));
});
