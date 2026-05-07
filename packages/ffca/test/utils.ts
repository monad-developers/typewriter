import { parseAbiParameters } from "abitype";
import { eq } from "drizzle-orm";
import {
  bigint,
  char,
  numeric,
  pgTable,
  primaryKey,
  smallint,
  text,
} from "drizzle-orm/pg-core";
import {
  AbiParameters,
  Hash,
  Hex as OxHex,
  P256,
  Secp256k1,
  type TypedData,
} from "ox";
import { Authentication } from "ox/webauthn";
import type { Address, Hex } from "viem";
import { anvil } from "viem/chains";
import type { FFCAMutationConfig, FFCAPersistContext } from "../src/config";
import { hashMutationEip712 } from "../src/eip712";
import { mutationColumns } from "../src/schema";
import {
  SCHEDULER_ACCOUNT,
  TEST_PUBLIC_CLIENT,
  TEST_WALLET_CLIENT,
} from "./setup";

// TS mirrors of each contract's State struct. The contracts use `mapping`s
// (which can't appear in JS); we represent them as `Record<address, ...>`.

// Counter.State on-chain. Tests that use COUNTER_MUTATIONS should pass
// `{ initial: { total: 0n, nonce: 0n } as CounterState }` as
// FFCAConfig.state.
export type CounterState = {
  total: bigint;
  nonce: bigint;
};

// Counter's signature wire shape. ffca encodes it into bundle.signatures[i]
// matching the contract's `Signature` struct.
export const COUNTER_SIGNATURE_PARAMS = parseAbiParameters(
  "uint8 keyType, bytes rawSignature",
);

// Counter's EIP-712 domain. Matches the constructor args used in
// deployCounter() so client-side digests align with the on-chain
// domainSeparator.
export const COUNTER_DOMAIN = { name: "Counter", version: "1" } as const;

// Harness.State on-chain. `accounts[id].keys` mirrors the contract's key
// registry; `accounts[id].nonces` mirrors per-(account, nonceKey)
// sequences. `balances` is keyed by the same bytes32 account id.
export type HarnessKey = { keyType: number; publicKey: Hex };
export type HarnessAccount = {
  keys: HarnessKey[];
  nonces: Record<string, bigint>;
};
export type HarnessState = {
  accounts: Record<Hex, HarnessAccount>;
  balances: Record<Hex, bigint>;
};

export const HARNESS_DOMAIN = { name: "Harness", version: "1" } as const;
export const HARNESS_SIGNATURE_PARAMS = parseAbiParameters(
  "bytes32 account, uint64 keyId, uint8 keyType, bytes rawSignature",
);

// Persisted shape of HarnessState. Mirrors Harness.sol's State struct: the
// `accounts` mapping fans out to (accounts, keys, nonces); `balances` is its
// own table keyed by the same bytes32 account id.
//
// Column-type aliases mirror ffca's shared column helpers where possible.
// uint192 is the high bits of a parallel nonce (Harness.sol stores
// `mapping(uint192 => uint64)`) — needs >64 bits, so numeric rather than
// bigint.
const uint8 = () => smallint();
const uint64 = () => bigint({ mode: "bigint" });
const uint192 = () => numeric({ precision: 58, scale: 0 });
const uint256 = () => numeric({ precision: 78, scale: 0 });
const bytes32 = () => char({ length: 66 });

export const harnessSignatureColumns = {
  account: bytes32().notNull(),
  keyId: uint64().notNull(),
  keyType: uint8().notNull(),
  rawSignature: text().notNull(),
};

export const counterAddMutations = pgTable("counter_add_mutations", {
  ...mutationColumns(),
  keyType: uint8().notNull(),
  rawSignature: text().notNull(),
  amount: uint256().notNull(),
  nonce: uint256().notNull(),
});

export const testMutationSchema = pgTable("test_mutations", {
  ...mutationColumns(),
});

export const harnessInitializeMutations = pgTable("harness_initializes", {
  ...mutationColumns(),
  ...harnessSignatureColumns,
  rootKeyType: uint8().notNull(),
  rootPublicKey: text().notNull(),
});

export const harnessAuthorizeMutations = pgTable("harness_authorizes", {
  ...mutationColumns(),
  ...harnessSignatureColumns,
  newKeyType: uint8().notNull(),
  publicKey: text().notNull(),
  nonce: uint256().notNull(),
});

export const harnessCreditMutations = pgTable("harness_credits", {
  ...mutationColumns(),
  ...harnessSignatureColumns,
  amount: uint256().notNull(),
  nonce: uint256().notNull(),
});

export const harnessDebitMutations = pgTable("harness_debits", {
  ...mutationColumns(),
  ...harnessSignatureColumns,
  amount: uint256().notNull(),
  nonce: uint256().notNull(),
  newBalance: uint256().notNull(),
});

export const harnessAssertMutations = pgTable("harness_asserts", {
  ...mutationColumns(),
  ...harnessSignatureColumns,
  expected: uint256().notNull(),
  nonce: uint256().notNull(),
});

export const harnessAccounts = pgTable("accounts", {
  id: bytes32().primaryKey(),
});

export const harnessKeys = pgTable(
  "keys",
  {
    account: bytes32()
      .notNull()
      .references(() => harnessAccounts.id),
    keyIndex: uint64().notNull(),
    keyType: uint8().notNull(),
    publicKey: text().notNull(),
  },
  (t) => [primaryKey({ columns: [t.account, t.keyIndex] })],
);

export const harnessNonces = pgTable(
  "nonces",
  {
    account: bytes32()
      .notNull()
      .references(() => harnessAccounts.id),
    nonceKey: uint192().notNull(),
    sequence: uint64().notNull(),
  },
  (t) => [primaryKey({ columns: [t.account, t.nonceKey] })],
);

export const harnessBalances = pgTable("balances", {
  account: bytes32()
    .primaryKey()
    .references(() => harnessAccounts.id),
  amount: uint256().notNull(),
});

export const HARNESS_SCHEMA = {
  initializeMutations: harnessInitializeMutations,
  authorizeMutations: harnessAuthorizeMutations,
  creditMutations: harnessCreditMutations,
  debitMutations: harnessDebitMutations,
  assertMutations: harnessAssertMutations,
  accounts: harnessAccounts,
  keys: harnessKeys,
  nonces: harnessNonces,
  balances: harnessBalances,
};

function getHarnessAccount(state: HarnessState, id: Hex): HarnessAccount {
  if (state.accounts[id] === undefined) {
    state.accounts[id] = { keys: [], nonces: {} };
  }
  return state.accounts[id];
}

function checkAndBumpNonce(
  acc: HarnessAccount,
  nonce: bigint,
  account: Hex,
): void {
  const nonceKey = (nonce >> 64n).toString();
  const seq = nonce & 0xffffffffffffffffn;
  const stored = acc.nonces[nonceKey] ?? 0n;
  if (seq !== stored) {
    throw new Error(
      `harness: nonce mismatch account=${account} key=${nonceKey} expected=${stored} got=${seq}`,
    );
  }
  acc.nonces[nonceKey] = stored + 1n;
}

// Deploy a forge-built contract by name. Reads the artifact from the
// contracts workspace, broadcasts via the test wallet, waits for the
// receipt, returns address + abi.
async function deployContract(
  name: string,
  args?: readonly unknown[],
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
    // biome-ignore lint/suspicious/noExplicitAny: viem deployContract args type
    args: args as any,
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

// Deploy Counter wired to a single secp256k1 signer. The contract hardcodes
// its EIP-712 domain (name="Counter", version="1"); only the signer is a
// constructor arg.
export async function deployCounter(signerAddress: Address) {
  return deployContract("Counter", [signerAddress]);
}

export const deployHarness = () => deployContract("Harness");

// Mutation definitions for the Counter test fixture. Each `add` contributes
// `amount` to a running total; ffca's local apply mirrors the contract.
// Local apply also bumps the nonce so the next mutation in the same bundle
// signs over the right value.
export const COUNTER_MUTATIONS: { add: FFCAMutationConfig } = {
  add: {
    tag: 0,
    table: counterAddMutations,
    params: parseAbiParameters("uint256 amount, uint256 nonce"),
    // @ts-expect-error
    apply: (
      state: CounterState,
      { amount, nonce }: { amount: bigint; nonce: bigint },
    ) => {
      if (nonce !== state.nonce) {
        throw new Error(
          `add: nonce mismatch (expected=${state.nonce}, got=${nonce})`,
        );
      }
      state.total += amount;
      state.nonce += 1n;
    },
  },
};

// Sign Counter's `add` mutation. Counter is a single-signer secp256k1
// fixture, so this always returns a secp256k1 rawSignature.
export function signCounter(params: {
  privateKey: Hex;
  amount: bigint;
  nonce: bigint;
  address: Address;
  chainId: number;
}): { keyType: 2; rawSignature: Hex } {
  const domain: TypedData.Domain = {
    name: COUNTER_DOMAIN.name,
    version: COUNTER_DOMAIN.version,
    chainId: params.chainId,
    verifyingContract: params.address,
  };
  const digest = hashMutationEip712(
    COUNTER_MUTATIONS.add,
    "add",
    { amount: params.amount, nonce: params.nonce },
    domain,
  );
  return {
    keyType: 2,
    rawSignature: signSecp256k1Raw(digest, params.privateKey),
  };
}

// Mutation definitions for the Harness test fixture. Tags match the contract:
//   initialize (0): bootstraps an account with a root key. Account id is
//                    derived as keccak256(rootPublicKey); no signature.
//   authorize  (1): adds a key to an existing account. Signed by an
//                    existing key.
//   credit     (2): adds amount to balance. Signed.
//   debit      (3): resolve computes newBalance from local state; the
//                    contract rejects the bundle if the resolution doesn't
//                    match its own pre-state. Signed.
//   assert     (4): read-only check; the contract reverts if balance !=
//                    expected. Signed.
type InitializeArgs = { rootKeyType: number; rootPublicKey: Hex };
type AuthorizeArgs = {
  account: Hex;
  keyId: bigint;
  keyType: number;
  publicKey: Hex;
  nonce: bigint;
};
type CreditArgs = {
  account: Hex;
  keyId: bigint;
  amount: bigint;
  nonce: bigint;
};
type DebitArgs = CreditArgs;
type AssertArgs = {
  account: Hex;
  keyId: bigint;
  expected: bigint;
  nonce: bigint;
};

type HarnessSignature = {
  account: Hex;
  keyId: bigint;
  keyType: number;
  rawSignature: Hex;
};

type HarnessPersistedMutation<TArgs, TResolution = unknown> = {
  id: number;
  status: string;
  args: TArgs;
  signature: HarnessSignature;
  resolution?: TResolution;
};

type HarnessPersistBundle = {
  id?: number;
  mutationIndex?: number;
};

type HarnessPersistBlock = {
  number?: bigint;
  hash?: Hex;
  timestamp?: bigint;
  transactionHash?: Hex;
};

function harnessDb(tx: unknown) {
  // biome-ignore lint/suspicious/noExplicitAny: persistence fixture accepts any Drizzle transaction shape
  return tx as any;
}

function harnessBaseMutationRow<TArgs>(
  ctx: FFCAPersistContext,
  mutation: HarnessPersistedMutation<TArgs>,
) {
  const bundle = ctx.bundle as HarnessPersistBundle | undefined;
  const block = ctx.block as HarnessPersistBlock | undefined;
  return {
    id: mutation.id,
    bundleId: bundle?.id,
    bundlePosition: bundle?.mutationIndex,
    blockNumber: block?.number?.toString(),
    blockHash: block?.hash,
    blockTimestamp: block?.timestamp?.toString(),
    transactionHash: block?.transactionHash,
    status: mutation.status,
    account: mutation.signature.account,
    keyId: mutation.signature.keyId,
    keyType: mutation.signature.keyType,
    rawSignature: mutation.signature.rawSignature,
  };
}

async function persistHarnessLifecycle(
  ctx: FFCAPersistContext,
  // biome-ignore lint/suspicious/noExplicitAny: works with any mutation table in this fixture
  table: any,
) {
  const mutation = ctx.mutation as HarnessPersistedMutation<unknown>;
  const block = ctx.block as HarnessPersistBlock | undefined;
  await harnessDb(ctx.tx)
    .update(table)
    .set({
      status: mutation.status,
      blockNumber: block?.number?.toString(),
      blockHash: block?.hash,
      blockTimestamp: block?.timestamp?.toString(),
      transactionHash: block?.transactionHash,
    })
    .where(eq(table.id, mutation.id));
}

async function persistHarnessAccount(ctx: FFCAPersistContext, account: Hex) {
  await harnessDb(ctx.tx)
    .insert(harnessAccounts)
    .values({ id: account })
    .onConflictDoNothing();
}

async function persistHarnessKey(
  ctx: FFCAPersistContext,
  account: Hex,
  keyIndex: number,
) {
  const state = ctx.state as HarnessState;
  const key = state.accounts[account]?.keys[keyIndex];
  if (key === undefined) return;
  await harnessDb(ctx.tx)
    .insert(harnessKeys)
    .values({
      account,
      keyIndex: BigInt(keyIndex),
      keyType: key.keyType,
      publicKey: key.publicKey,
    })
    .onConflictDoUpdate({
      target: [harnessKeys.account, harnessKeys.keyIndex],
      set: {
        keyType: key.keyType,
        publicKey: key.publicKey,
      },
    });
}

async function persistHarnessNonce(
  ctx: FFCAPersistContext,
  account: Hex,
  nonce: bigint,
) {
  const state = ctx.state as HarnessState;
  const nonceKey = (nonce >> 64n).toString();
  const sequence = state.accounts[account]?.nonces[nonceKey] ?? 0n;
  await harnessDb(ctx.tx)
    .insert(harnessNonces)
    .values({ account, nonceKey, sequence })
    .onConflictDoUpdate({
      target: [harnessNonces.account, harnessNonces.nonceKey],
      set: { sequence },
    });
}

async function persistHarnessBalance(ctx: FFCAPersistContext, account: Hex) {
  const state = ctx.state as HarnessState;
  const amount = state.balances[account] ?? 0n;
  await harnessDb(ctx.tx)
    .insert(harnessBalances)
    .values({ account, amount: amount.toString() })
    .onConflictDoUpdate({
      target: harnessBalances.account,
      set: { amount: amount.toString() },
    });
}

export const HARNESS_MUTATIONS: {
  initialize: FFCAMutationConfig;
  authorize: FFCAMutationConfig;
  credit: FFCAMutationConfig;
  debit: FFCAMutationConfig;
  assert: FFCAMutationConfig;
} = {
  initialize: {
    tag: 0,
    table: harnessInitializeMutations,
    params: parseAbiParameters("uint8 rootKeyType, bytes rootPublicKey"),
    // @ts-expect-error
    apply: (state: HarnessState, args: InitializeArgs) => {
      const id = Hash.keccak256(args.rootPublicKey) as Hex;
      const acc = getHarnessAccount(state, id);
      if (acc.keys.length !== 0) {
        throw new Error(`initialize: account ${id} already initialized`);
      }
      acc.keys.push({
        keyType: args.rootKeyType,
        publicKey: args.rootPublicKey,
      });
    },
  },
  authorize: {
    tag: 1,
    table: harnessAuthorizeMutations,
    params: parseAbiParameters(
      "bytes32 account, uint64 keyId, uint8 keyType, bytes publicKey, uint256 nonce",
    ),
    // @ts-expect-error
    apply: (state: HarnessState, args: AuthorizeArgs) => {
      const acc = getHarnessAccount(state, args.account);
      checkAndBumpNonce(acc, args.nonce, args.account);
      acc.keys.push({ keyType: args.keyType, publicKey: args.publicKey });
    },
  },
  credit: {
    tag: 2,
    table: harnessCreditMutations,
    params: parseAbiParameters(
      "bytes32 account, uint64 keyId, uint256 amount, uint256 nonce",
    ),
    // @ts-expect-error
    apply: (state: HarnessState, args: CreditArgs) => {
      const acc = getHarnessAccount(state, args.account);
      checkAndBumpNonce(acc, args.nonce, args.account);
      state.balances[args.account] =
        (state.balances[args.account] ?? 0n) + args.amount;
    },
  },
  debit: {
    tag: 3,
    table: harnessDebitMutations,
    params: parseAbiParameters(
      "bytes32 account, uint64 keyId, uint256 amount, uint256 nonce",
    ),
    resolution: parseAbiParameters("uint256 newBalance"),
    // @ts-expect-error
    resolve: (state: HarnessState, args: DebitArgs) => {
      return {
        newBalance: (state.balances[args.account] ?? 0n) - args.amount,
      };
    },
    // @ts-expect-error
    apply: (
      state: HarnessState,
      args: DebitArgs,
      { newBalance }: { newBalance: bigint },
    ) => {
      const acc = getHarnessAccount(state, args.account);
      checkAndBumpNonce(acc, args.nonce, args.account);
      if (newBalance < 0n) {
        throw new Error(`debit: insufficient balance for ${args.account}`);
      }
      state.balances[args.account] = newBalance;
    },
  },
  assert: {
    tag: 4,
    table: harnessAssertMutations,
    params: parseAbiParameters(
      "bytes32 account, uint64 keyId, uint256 expected, uint256 nonce",
    ),
    // @ts-expect-error
    apply: (state: HarnessState, args: AssertArgs) => {
      const acc = getHarnessAccount(state, args.account);
      checkAndBumpNonce(acc, args.nonce, args.account);
      const balance = state.balances[args.account] ?? 0n;
      if (balance !== args.expected) {
        throw new Error(
          `assert: account=${args.account} balance=${balance} expected=${args.expected}`,
        );
      }
    },
  },
};

// Same Harness behavior as HARNESS_MUTATIONS, with user-owned persistence
// callbacks attached. This fixture is intentionally not wired into runtime
// tests yet; it sketches the database contract the app would own.
export const HARNESS_PERSISTED_MUTATIONS: {
  initialize: FFCAMutationConfig;
  authorize: FFCAMutationConfig;
  credit: FFCAMutationConfig;
  debit: FFCAMutationConfig;
  assert: FFCAMutationConfig;
} = {
  initialize: {
    ...HARNESS_MUTATIONS.initialize,
    persistMutation: async (ctx) => {
      const mutation = ctx.mutation as HarnessPersistedMutation<InitializeArgs>;
      await harnessDb(ctx.tx)
        .insert(harnessInitializeMutations)
        .values({
          ...harnessBaseMutationRow(ctx, mutation),
          rootKeyType: mutation.args.rootKeyType,
          rootPublicKey: mutation.args.rootPublicKey,
        });
    },
    persistLifecycle: (ctx) =>
      persistHarnessLifecycle(ctx, harnessInitializeMutations),
    persistState: async (ctx) => {
      const mutation = ctx.mutation as HarnessPersistedMutation<InitializeArgs>;
      const account = mutation.signature.account;
      await persistHarnessAccount(ctx, account);
      await persistHarnessKey(ctx, account, 0);
    },
  },
  authorize: {
    ...HARNESS_MUTATIONS.authorize,
    persistMutation: async (ctx) => {
      const mutation = ctx.mutation as HarnessPersistedMutation<AuthorizeArgs>;
      await harnessDb(ctx.tx)
        .insert(harnessAuthorizeMutations)
        .values({
          ...harnessBaseMutationRow(ctx, mutation),
          newKeyType: mutation.args.keyType,
          publicKey: mutation.args.publicKey,
          nonce: mutation.args.nonce.toString(),
        });
    },
    persistLifecycle: (ctx) =>
      persistHarnessLifecycle(ctx, harnessAuthorizeMutations),
    persistState: async (ctx) => {
      const mutation = ctx.mutation as HarnessPersistedMutation<AuthorizeArgs>;
      const state = ctx.state as HarnessState;
      const keyIndex =
        (state.accounts[mutation.args.account]?.keys.length ?? 1) - 1;
      await persistHarnessAccount(ctx, mutation.args.account);
      await persistHarnessKey(ctx, mutation.args.account, keyIndex);
      await persistHarnessNonce(
        ctx,
        mutation.args.account,
        mutation.args.nonce,
      );
    },
  },
  credit: {
    ...HARNESS_MUTATIONS.credit,
    persistMutation: async (ctx) => {
      const mutation = ctx.mutation as HarnessPersistedMutation<CreditArgs>;
      await harnessDb(ctx.tx)
        .insert(harnessCreditMutations)
        .values({
          ...harnessBaseMutationRow(ctx, mutation),
          amount: mutation.args.amount.toString(),
          nonce: mutation.args.nonce.toString(),
        });
    },
    persistLifecycle: (ctx) =>
      persistHarnessLifecycle(ctx, harnessCreditMutations),
    persistState: async (ctx) => {
      const mutation = ctx.mutation as HarnessPersistedMutation<CreditArgs>;
      await persistHarnessAccount(ctx, mutation.args.account);
      await persistHarnessBalance(ctx, mutation.args.account);
      await persistHarnessNonce(
        ctx,
        mutation.args.account,
        mutation.args.nonce,
      );
    },
  },
  debit: {
    ...HARNESS_MUTATIONS.debit,
    persistMutation: async (ctx) => {
      const mutation = ctx.mutation as HarnessPersistedMutation<
        DebitArgs,
        { newBalance: bigint }
      >;
      await harnessDb(ctx.tx)
        .insert(harnessDebitMutations)
        .values({
          ...harnessBaseMutationRow(ctx, mutation),
          amount: mutation.args.amount.toString(),
          nonce: mutation.args.nonce.toString(),
          newBalance: mutation.resolution?.newBalance.toString(),
        });
    },
    persistLifecycle: (ctx) =>
      persistHarnessLifecycle(ctx, harnessDebitMutations),
    persistState: async (ctx) => {
      const mutation = ctx.mutation as HarnessPersistedMutation<DebitArgs>;
      await persistHarnessAccount(ctx, mutation.args.account);
      await persistHarnessBalance(ctx, mutation.args.account);
      await persistHarnessNonce(
        ctx,
        mutation.args.account,
        mutation.args.nonce,
      );
    },
  },
  assert: {
    ...HARNESS_MUTATIONS.assert,
    persistMutation: async (ctx) => {
      const mutation = ctx.mutation as HarnessPersistedMutation<AssertArgs>;
      await harnessDb(ctx.tx)
        .insert(harnessAssertMutations)
        .values({
          ...harnessBaseMutationRow(ctx, mutation),
          expected: mutation.args.expected.toString(),
          nonce: mutation.args.nonce.toString(),
        });
    },
    persistLifecycle: (ctx) =>
      persistHarnessLifecycle(ctx, harnessAssertMutations),
    persistState: async (ctx) => {
      const mutation = ctx.mutation as HarnessPersistedMutation<AssertArgs>;
      await persistHarnessAccount(ctx, mutation.args.account);
      await persistHarnessNonce(
        ctx,
        mutation.args.account,
        mutation.args.nonce,
      );
    },
  },
};

// Derive the bytes32 account id from a public key (matches Harness.sol's
// `keccak256(rootPublicKey)` bootstrap rule).
export function harnessAccountId(publicKey: Hex): Hex {
  return Hash.keccak256(publicKey) as Hex;
}

// secp256k1 public key for an EOA, in the abi.encode(address) form
// Account.sol's verifySecp256k1 expects.
export function secp256k1PublicKey(address: Address): Hex {
  return AbiParameters.encode(parseAbiParameters("address"), [address]);
}

// P-256 public key for a private key, in the abi.encode(uint256 x, uint256 y)
// form Account.sol's verifyP256 / decodeP256PublicKey accepts.
export function p256PublicKey(privateKey: Hex): Hex {
  const pk = P256.getPublicKey({ privateKey });
  return AbiParameters.encode(parseAbiParameters("uint256 x, uint256 y"), [
    pk.x,
    pk.y,
  ]);
}

// Sign a digest with a P-256 private key. Returns rawSignature in the
// abi.encode(uint256 r, uint256 s) form. The contract sha256s the digest
// before passing to the precompile, so we sign with hash: true to match.
export function signP256Raw(digest: Hex, privateKey: Hex): Hex {
  const sig = P256.sign({ payload: digest, privateKey, hash: true });
  return AbiParameters.encode(parseAbiParameters("uint256 r, uint256 s"), [
    sig.r,
    sig.s,
  ]);
}

// Sign a digest as a WebAuthn-P256 challenge. Returns rawSignature in the
// abi.encode(bytes authData, bytes clientDataJSON, uint256 challengeOffset,
// uint256 r, uint256 s) form Account.sol's verifyWebAuthnP256 expects.
//
// rpId/origin are fixed to empty strings — Account.sol doesn't inspect
// either, so their values don't affect on-chain verification. Real apps
// that care about origin enforcement would do that check off-chain
// (browser refuses to sign for the wrong RP ID anyway).
export function signWebAuthnP256Raw(digest: Hex, privateKey: Hex): Hex {
  const { metadata, payload } = Authentication.getSignPayload({
    challenge: digest,
    rpId: "",
    origin: "",
    userVerification: "required",
  });
  const sig = P256.sign({ payload, privateKey, hash: true });
  // Account.sol's verifyChallenge expects the byte offset at which the
  // base64url-encoded challenge VALUE starts inside clientDataJSON. ox's
  // `challengeIndex` points at the JSON key (`"challenge":"`), so add 13
  // to land on the first byte of the value.
  const challengeOffset =
    metadata.clientDataJSON.indexOf('"challenge":"') + '"challenge":"'.length;
  return AbiParameters.encode(
    parseAbiParameters(
      "bytes authData, bytes clientDataJSON, uint256 challengeOffset, uint256 r, uint256 s",
    ),
    [
      metadata.authenticatorData,
      OxHex.fromString(metadata.clientDataJSON),
      BigInt(challengeOffset),
      sig.r,
      sig.s,
    ],
  );
}

// Sign one of Harness's signed mutation types. Returns the structured
// signature ffca encodes into bundle.signatures[i].
export function signHarness(params: {
  keyType: number;
  privateKey: Hex;
  mutation: "authorize" | "credit" | "debit" | "assert";
  args: Record<string, unknown>;
  address: Address;
  chainId: number;
}): Hex {
  const domain: TypedData.Domain = {
    name: HARNESS_DOMAIN.name,
    version: HARNESS_DOMAIN.version,
    chainId: params.chainId,
    verifyingContract: params.address,
  };
  const digest = hashMutationEip712(
    HARNESS_MUTATIONS[params.mutation],
    params.mutation,
    params.args,
    domain,
  );
  if (params.keyType === 0) return signP256Raw(digest, params.privateKey);
  if (params.keyType === 1)
    return signWebAuthnP256Raw(digest, params.privateKey);
  if (params.keyType === 2) return signSecp256k1Raw(digest, params.privateKey);
  throw new Error(`signHarness: unknown keyType ${params.keyType}`);
}

function signSecp256k1Raw(digest: Hex, privateKey: Hex): Hex {
  const signature = Secp256k1.sign({ payload: digest, privateKey });
  return AbiParameters.encode(
    parseAbiParameters("uint8 v, bytes32 r, bytes32 s"),
    [
      signature.yParity + 27,
      OxHex.fromNumber(signature.r, { size: 32 }),
      OxHex.fromNumber(signature.s, { size: 32 }),
    ],
  );
}

// Bootstrap an account by submitting an `initialize` mutation. Returns the
// derived account id so callers can reference it. The signature is unused
// by the contract (initialize is bootstrap) but ffca's wire format still
// requires a structured value, so we pass a stub.
export async function setupHarnessAccount(
  // biome-ignore lint/suspicious/noExplicitAny: structural typing for the ffca instance
  ffca: { execute: (m: any) => Promise<any> },
  params: { rootKeyType: number; rootPublicKey: Hex },
): Promise<Hex> {
  const account = harnessAccountId(params.rootPublicKey);
  await ffca.execute({
    name: "initialize",
    args: {
      rootKeyType: params.rootKeyType,
      rootPublicKey: params.rootPublicKey,
    },
    signature: {
      account,
      keyId: 0n,
      keyType: params.rootKeyType,
      rawSignature: "0x",
    },
  });
  return account;
}
