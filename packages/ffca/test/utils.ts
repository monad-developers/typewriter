import { parseAbiParameters } from "abitype";
import type { Address, Hex } from "viem";
import { anvil } from "viem/chains";
import type { FFCAMutationConfig } from "../src/config";
import {
  SCHEDULER_ACCOUNT,
  TEST_PUBLIC_CLIENT,
  TEST_WALLET_CLIENT,
} from "./setup";

// TS mirrors of each contract's State struct. The contracts use `mapping`s
// (which can't appear in JS); we represent them as `Record<address, ...>`.

// Counter.State on-chain. Tests that use COUNTER_MUTATIONS should pass
// `{ initial: { total: 0n } as CounterState }` as the FFCAConfig.state.
export type CounterState = {
  total: bigint;
};

// Harness.State on-chain. Tests that use HARNESS_MUTATIONS should pass
// `{ initial: { balances: {} } as HarnessState }` as the FFCAConfig.state.
export type HarnessState = {
  balances: Record<string, bigint>;
};

// Deploy a forge-built contract by name. Reads the artifact from the
// contracts workspace, broadcasts via the test wallet, waits for the
// receipt, returns address + abi.
async function deployContract(
  name: string,
  // biome-ignore lint/suspicious/noExplicitAny: forge artifact JSON shape
): Promise<{ address: Address; abi: any }> {
  const artifact = await Bun.file(
    `${import.meta.dir}/contracts/out/${name}.sol/${name}.json`,
  ).json();
  const hash = await TEST_WALLET_CLIENT.deployContract({
    abi: artifact.abi,
    bytecode: artifact.bytecode.object as Hex,
    account: SCHEDULER_ACCOUNT,
    chain: anvil,
  });
  const receipt = await TEST_PUBLIC_CLIENT.waitForTransactionReceipt({ hash });
  if (
    receipt.contractAddress === null ||
    receipt.contractAddress === undefined
  ) {
    throw new Error(`${name} deploy missing address`);
  }
  return { address: receipt.contractAddress, abi: artifact.abi };
}

export const deployCounter = () => deployContract("Counter");
export const deployHarness = () => deployContract("Harness");

// Mutation definitions for the Counter test fixture. Each `add` contributes
// `amount` to a running total; ffca's local apply mirrors the contract.
export const COUNTER_MUTATIONS: { add: FFCAMutationConfig } = {
  add: {
    tag: 0,
    params: parseAbiParameters("uint256 amount"),
    // @ts-ignore
    apply: (state: CounterState, { amount }: { amount: bigint }) => {
      state.total += amount;
    },
  },
};

// Mutation definitions for the Harness test fixture. Tags match the contract:
//   credit (0): adds amount to balance.
//   debit  (1): resolve computes newBalance from local state; the contract
//                rejects the bundle if the resolution doesn't match its
//                own pre-state. Exercises the resolve→encode→verify path.
//   assert (2): read-only check; the contract reverts if balance != expected.
//                No state effect, so the local apply is intentionally empty.
export const HARNESS_MUTATIONS: {
  credit: FFCAMutationConfig;
  debit: FFCAMutationConfig;
  assert: FFCAMutationConfig;
} = {
  credit: {
    tag: 0,
    params: parseAbiParameters("address account, uint256 amount"),
    // @ts-ignore
    apply: (
      state: HarnessState,
      { account, amount }: { account: string; amount: bigint },
    ) => {
      state.balances[account] = (state.balances[account] ?? 0n) + amount;
    },
  },
  debit: {
    tag: 1,
    params: parseAbiParameters("address account, uint256 amount"),
    resolution: parseAbiParameters("uint256 newBalance"),
    // @ts-ignore
    resolve: (
      state: HarnessState,
      { account, amount }: { account: string; amount: bigint },
    ) => {
      return { newBalance: (state.balances[account] ?? 0n) - amount };
    },
    // @ts-ignore
    apply: (
      state: HarnessState,
      { account }: { account: string },
      { newBalance }: { newBalance: bigint },
    ) => {
      // Mirrors the contract's require: insufficient balance reverts.
      if (newBalance < 0n) {
        throw new Error(`debit: insufficient balance for ${account}`);
      }
      state.balances[account] = newBalance;
    },
  },
  assert: {
    tag: 2,
    params: parseAbiParameters("address account, uint256 expected"),
    // Read-only on-chain; no local state effect to mirror.
    apply: () => {},
  },
};
