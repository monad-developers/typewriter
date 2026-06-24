import { expectTypeOf, test } from "bun:test";
import type { StorageProxy } from "storage-layout";
import type { Hex } from "viem";
import {
  COUNTER_MUTATIONS,
  type COUNTER_SIGNATURE_PARAMS,
  type EMPTY_STORAGE_LAYOUT,
  HARNESS_MUTATIONS,
  type HARNESS_SIGNATURE_PARAMS,
} from "../test/utils";
import type {
  AbiParametersToValue,
  MutationsConfig,
  ResolvedTypewriterMutationConfig,
  SequencingConfig,
  SignatureConfig,
  StorageConfig,
  TypewriterConfig,
} from "./config";
import { TYPEWRITER_DOMAIN } from "./eip712";
import type { Typewriter, TypewriterMutationInput } from "./index";

function createTypewriterTest<
  storageConfig extends StorageConfig = StorageConfig,
  mutationsConfig extends MutationsConfig = MutationsConfig,
  signatureConfig extends SignatureConfig = SignatureConfig,
  sequencingConfig extends SequencingConfig = SequencingConfig,
>(): Typewriter<
  storageConfig,
  mutationsConfig,
  signatureConfig,
  sequencingConfig
> {
  return {
    state: {},
    schema: {},
    domain: {
      ...TYPEWRITER_DOMAIN,
      chainId: 1,
      verifyingContract: "0x0000000000000000000000000000000000000000",
    },
    execute: async () => ({ id: 0 }),
    on: () => () => {},
  } as unknown as Typewriter<
    storageConfig,
    mutationsConfig,
    signatureConfig,
    sequencingConfig
  >;
}

type TestStorageConfig = typeof EMPTY_STORAGE_LAYOUT;
type CounterMutationsConfig = typeof COUNTER_MUTATIONS;
type CounterSignatureConfig = typeof COUNTER_SIGNATURE_PARAMS;
type HarnessMutationsConfig = typeof HARNESS_MUTATIONS;
type HarnessSignatureConfig = typeof HARNESS_SIGNATURE_PARAMS;

const publicConfig = {
  address: "0x0000000000000000000000000000000000000000",
  // biome-ignore lint/suspicious/noExplicitAny: stub field, types not the focus
  account: {} as any,
  chainId: 1,
  rpcUrl: "http://localhost:8545",
  database: { url: "postgres://postgres@localhost:5432/postgres" },
} as const satisfies TypewriterConfig;

test("TypewriterConfig accepts app-owned runtime config only", () => {
  void publicConfig;
});

test("ResolvedTypewriterMutationConfig accepts Counter mutation definitions", () => {
  const mutations = COUNTER_MUTATIONS satisfies Record<
    string,
    ResolvedTypewriterMutationConfig
  >;
  void mutations;
});

test("ResolvedTypewriterMutationConfig accepts Harness mutation definitions", () => {
  const mutations = HARNESS_MUTATIONS satisfies Record<
    string,
    ResolvedTypewriterMutationConfig
  >;
  void mutations;
});

test("Typewriter state is typed from supplied storage config", () => {
  const app = createTypewriterTest<
    TestStorageConfig,
    CounterMutationsConfig,
    CounterSignatureConfig
  >();

  expectTypeOf(app.state).toEqualTypeOf<
    StorageProxy<TestStorageConfig, true>
  >();
});

test("Typewriter execute input uses manually supplied Counter mutation and signature configs", () => {
  const app = createTypewriterTest<
    TestStorageConfig,
    CounterMutationsConfig,
    CounterSignatureConfig
  >();

  type Input = Parameters<typeof app.execute>[0];

  expectTypeOf<Input>().toEqualTypeOf<
    TypewriterMutationInput<CounterMutationsConfig, CounterSignatureConfig>
  >();

  type CounterSignature = AbiParametersToValue<CounterSignatureConfig>;

  expectTypeOf<Input["name"]>().toEqualTypeOf<
    keyof CounterMutationsConfig & string
  >();
  const signature = {
    accountId: "0x" as Hex,
    publicKey: "0x" as Hex,
    rawSignature: "0x" as Hex,
  } satisfies CounterSignature;
  const newAccountInput = {
    name: "NewAccount",
    params: { keyType: 2, publicKey: "0x" as Hex },
    signature,
  } satisfies Input;
  const addInput = {
    name: "Add",
    params: { amount: 1n, nonce: 0n },
    signature,
  } satisfies Input;

  expectTypeOf(newAccountInput).toMatchTypeOf<
    Extract<Input, { name: "NewAccount" }>
  >();
  expectTypeOf(addInput).toMatchTypeOf<Extract<Input, { name: "Add" }>>();

  const acceptInput = (_input: Input) => {};

  acceptInput({
    name: "Add",
    // @ts-expect-error `Add` must use the `Add` ABI params, not `NewAccount` params.
    params: { keyType: 2, publicKey: "0x" as Hex },
    signature,
  });

  acceptInput({
    name: "NewAccount",
    params: { keyType: 2, publicKey: "0x" as Hex },
    // @ts-expect-error `NewAccount` must use Counter's configured signature shape.
    signature: { rawSignature: "0x" as Hex },
  });
});

test("Typewriter execute input uses manually supplied Harness mutation and signature configs", () => {
  const app = createTypewriterTest<
    TestStorageConfig,
    HarnessMutationsConfig,
    HarnessSignatureConfig
  >();

  type Input = Parameters<typeof app.execute>[0];

  expectTypeOf<Input>().toEqualTypeOf<
    TypewriterMutationInput<HarnessMutationsConfig, HarnessSignatureConfig>
  >();

  type HarnessSignature = AbiParametersToValue<HarnessSignatureConfig>;

  expectTypeOf<Input["name"]>().toEqualTypeOf<
    keyof HarnessMutationsConfig & string
  >();
  const signature = {
    account: "0x" as Hex,
    keyId: 0n,
    keyType: 2,
    rawSignature: "0x" as Hex,
  } satisfies HarnessSignature;
  const debitInput = {
    name: "Debit",
    params: {
      account: "0x" as Hex,
      keyId: 0n,
      amount: 1n,
      nonce: 0n,
    },
    signature,
  } satisfies Input;

  expectTypeOf(debitInput).toMatchTypeOf<Extract<Input, { name: "Debit" }>>();

  const acceptInput = (_input: Input) => {};

  acceptInput({
    name: "Debit",
    // @ts-expect-error `Debit` requires the Harness debit ABI params.
    params: { rootKeyType: 2, rootPublicKey: "0x" as Hex },
    signature,
  });
});

test("Typewriter sequencing type is represented in the app type", () => {
  const app = createTypewriterTest<
    TestStorageConfig,
    CounterMutationsConfig,
    CounterSignatureConfig,
    "batch"
  >();

  expectTypeOf(app).toEqualTypeOf<
    Typewriter<
      TestStorageConfig,
      CounterMutationsConfig,
      CounterSignatureConfig,
      "batch"
    >
  >();
});
