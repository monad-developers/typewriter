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
import { AbiFunction, AbiParameters, type Address, Hash, Hex } from "ox";
import { createEVM } from "./index";

const initWithCounter = {
  accounts: {
    [COUNTER_ADDR]: { code: COUNTER_CODE },
  },
} as const;

const TOKEN_ADDR = "0x0000000000000000000000000000000000000e20" as const;
const SCHEDULER_ADDR = "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266" as const;
const USER_ADDR = "0x70997970c51812dc3a010c7d01b50e0d17dc79c8" as const;
const RECIPIENT_ADDR = "0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc" as const;

const INITIAL_SUPPLY = 1_000_000_000_000_000_000_000n;
const TRANSFER_AMOUNT = 123_000_000_000_000_000_000n;
const SIMULATE_AMOUNT = 456_000_000_000_000_000_000n;

const TOTAL_SUPPLY_SLOT = Hex.fromNumber(2n, { size: 32 });
const BALANCE_OF_SLOT = 3n;

type ForgeArtifact = {
  deployedBytecode: { object: Hex.Hex };
};

function mappingSlot(key: Address.Address, slot: bigint): Hex.Hex {
  return Hash.keccak256(
    AbiParameters.encode(AbiParameters.from("address, uint256"), [key, slot]),
  );
}

function normalizeAccessRecord(
  record: Record<string, Hex.Hex[]>,
): Record<string, Hex.Hex[]> {
  const entries: [string, Hex.Hex[]][] = Object.entries(record).map(
    ([address, storageKeys]) => [
      address.toLowerCase(),
      [...storageKeys].sort(),
    ],
  );
  entries.sort((a, b) => a[0].localeCompare(b[0]));
  return Object.fromEntries(entries);
}

async function loadTestToken(): Promise<ForgeArtifact> {
  return (await Bun.file(
    `${import.meta.dir}/../test/contracts/out/TestToken.sol/TestToken.json`,
  ).json()) as ForgeArtifact;
}

function tokenInit(artifact: ForgeArtifact) {
  const schedulerBalanceSlot = mappingSlot(SCHEDULER_ADDR, BALANCE_OF_SLOT);
  return {
    schedulerBalanceSlot,
    params: {
      chain_id: 31337,
      accounts: {
        [TOKEN_ADDR]: {
          code: artifact.deployedBytecode.object,
          storage: {
            [TOTAL_SUPPLY_SLOT]: Hex.fromNumber(INITIAL_SUPPLY, { size: 32 }),
            [schedulerBalanceSlot]: Hex.fromNumber(INITIAL_SUPPLY, {
              size: 32,
            }),
          },
        },
      },
    },
  } as const;
}

function transferData(to: Address.Address, amount: bigint): Hex.Hex {
  const transfer = AbiFunction.from(
    "function transfer(address to, uint256 amount) returns (bool)",
  );
  return AbiFunction.encodeData(transfer, [to, amount]);
}

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
    const commit = yield* evm.commitBundles();
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
    return yield* evm.commitBundles();
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
    return yield* evm.commitBundles();
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
    yield* evm.commitBundles();

    yield* evm.beginBundle();
    yield* evm.execute({ from: CALLER, to: COUNTER_ADDR, data: "0x" });
    return yield* evm.commitBundles();
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
    const commit = yield* evm.commitBundles();
    return { exec, commit };
  });

  const { exec, commit } = await Effect.runPromise(Effect.scoped(program));
  expect(exec.success).toBe(false);
  expect(exec.revert_data).toBe("0x");
  expect(commit.state_diff).toEqual({});
});

test("execute returns access_list with the counter address + slot 0", async () => {
  const program = Effect.gen(function* () {
    const evm = yield* createEVM();
    yield* evm.init(initWithCounter);
    yield* evm.beginBundle();
    return yield* evm.execute({ from: CALLER, to: COUNTER_ADDR, data: "0x" });
  });

  const exec = await Effect.runPromise(Effect.scoped(program));
  expect(exec.access_list[COUNTER_ADDR]).toEqual([
    "0x0000000000000000000000000000000000000000000000000000000000000000",
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
    const commit = yield* evm.commitBundles();
    return { sim, commit };
  });

  const { sim, commit } = await Effect.runPromise(Effect.scoped(program));
  expect(sim.success).toBe(true);
  expect(commit.state_diff[COUNTER_ADDR]?.storage).toEqual({
    "0x0000000000000000000000000000000000000000000000000000000000000000":
      "0x0000000000000000000000000000000000000000000000000000000000000001",
  });
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

    // commitBundles drains the whole stack and reports the cumulative diff.
    return { sim, commit: yield* evm.commitBundles() };
  });

  const { sim, commit } = await Effect.runPromise(Effect.scoped(program));
  expect(sim.success).toBe(true);
  // After both bundles plus a no-op simulate: slot at 2.
  expect(commit.state_diff[COUNTER_ADDR]?.storage).toEqual({
    "0x0000000000000000000000000000000000000000000000000000000000000000":
      "0x0000000000000000000000000000000000000000000000000000000000000002",
  });
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
    const commit = yield* evm.commitBundles();
    return { exec, commit };
  });

  const { exec, commit } = await Effect.runPromise(Effect.scoped(program));

  expect({
    accessList: normalizeAccessRecord(exec.access_list),
    stateDiff: commit.state_diff[TOKEN_ADDR]?.storage,
    success: exec.success,
    slots: {
      schedulerBalanceSlot,
      totalSupplySlot: TOTAL_SUPPLY_SLOT,
      userBalanceSlot,
    },
  }).toMatchInlineSnapshot(`
    {
      "accessList": {
        "0x0000000000000000000000000000000000000000": [],
        "0x0000000000000000000000000000000000000e20": [
          "0x9c35da83f88043b3115f30d93beacec49ca14b6238430bdff196a249c29baa80",
          "0xc651ee22c6951bb8b5bd29e8210fb394645a94315fe10eff2cc73de1aa75c137",
        ],
        "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266": [],
      },
      "slots": {
        "schedulerBalanceSlot": "0xc651ee22c6951bb8b5bd29e8210fb394645a94315fe10eff2cc73de1aa75c137",
        "totalSupplySlot": "0x0000000000000000000000000000000000000000000000000000000000000002",
        "userBalanceSlot": "0x9c35da83f88043b3115f30d93beacec49ca14b6238430bdff196a249c29baa80",
      },
      "stateDiff": {
        "0x9c35da83f88043b3115f30d93beacec49ca14b6238430bdff196a249c29baa80": "0x000000000000000000000000000000000000000000000006aaf7c8516d0c0000",
        "0xc651ee22c6951bb8b5bd29e8210fb394645a94315fe10eff2cc73de1aa75c137": "0x00000000000000000000000000000000000000000000002f8ad1e57471940000",
      },
      "success": true,
    }
  `);
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
    const commit = yield* evm.commitBundles();
    return { optimistic, simulated, commit };
  });

  const { optimistic, simulated, commit } = await Effect.runPromise(
    Effect.scoped(program),
  );

  expect({
    commitStateDiff: commit.state_diff[TOKEN_ADDR]?.storage,
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
      "commitStateDiff": {
        "0x9c35da83f88043b3115f30d93beacec49ca14b6238430bdff196a249c29baa80": "0x000000000000000000000000000000000000000000000006aaf7c8516d0c0000",
        "0xc651ee22c6951bb8b5bd29e8210fb394645a94315fe10eff2cc73de1aa75c137": "0x00000000000000000000000000000000000000000000002f8ad1e57471940000",
      },
      "optimisticAccessList": {
        "0x0000000000000000000000000000000000000000": [],
        "0x0000000000000000000000000000000000000e20": [
          "0x9c35da83f88043b3115f30d93beacec49ca14b6238430bdff196a249c29baa80",
          "0xc651ee22c6951bb8b5bd29e8210fb394645a94315fe10eff2cc73de1aa75c137",
        ],
        "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266": [],
      },
      "optimisticSuccess": true,
      "simulatedAccessList": {
        "0x0000000000000000000000000000000000000000": [],
        "0x0000000000000000000000000000000000000e20": [
          "0x961ec03a078fec1e350bb1ca3bff1afa4bae5fb83d9d8382550c2fd26a7d7527",
          "0xc651ee22c6951bb8b5bd29e8210fb394645a94315fe10eff2cc73de1aa75c137",
        ],
        "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266": [],
      },
      "simulatedSuccess": true,
      "slots": {
        "recipientBalanceSlot": "0x961ec03a078fec1e350bb1ca3bff1afa4bae5fb83d9d8382550c2fd26a7d7527",
        "schedulerBalanceSlot": "0xc651ee22c6951bb8b5bd29e8210fb394645a94315fe10eff2cc73de1aa75c137",
        "userBalanceSlot": "0x9c35da83f88043b3115f30d93beacec49ca14b6238430bdff196a249c29baa80",
      },
    }
  `);
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
