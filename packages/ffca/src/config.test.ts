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
  FFCAConfig,
  MutationsConfig,
  ResolvedFFCAMutationConfig,
  SequencingConfig,
  SignatureConfig,
  StorageConfig,
} from "./config";
import type { FFCA, FFCAMutationInput } from "./index";

function createFFCATest<
  storageConfig extends StorageConfig = StorageConfig,
  mutationsConfig extends MutationsConfig = MutationsConfig,
  signatureConfig extends SignatureConfig = SignatureConfig,
  sequencingConfig extends SequencingConfig = SequencingConfig,
>(): FFCA<storageConfig, mutationsConfig, signatureConfig, sequencingConfig> {
  return {
    state: {},
    schema: {},
    domain: {},
    execute: async () => ({ id: 0 }),
    on: () => () => {},
  } as unknown as FFCA<
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
  domain: { name: "", version: "1" },
} as const satisfies FFCAConfig;

test("FFCAConfig accepts app-owned runtime config only", () => {
  void publicConfig;
});

test("ResolvedFFCAMutationConfig accepts Counter mutation definitions", () => {
  const mutations = COUNTER_MUTATIONS satisfies Record<
    string,
    ResolvedFFCAMutationConfig
  >;
  void mutations;
});

test("ResolvedFFCAMutationConfig accepts Harness mutation definitions", () => {
  const mutations = HARNESS_MUTATIONS satisfies Record<
    string,
    ResolvedFFCAMutationConfig
  >;
  void mutations;
});

test("FFCA state is typed from supplied storage config", () => {
  const app = createFFCATest<
    TestStorageConfig,
    CounterMutationsConfig,
    CounterSignatureConfig
  >();

  expectTypeOf(app.state).toEqualTypeOf<
    StorageProxy<TestStorageConfig, true>
  >();
});

test("FFCA execute input uses manually supplied Counter mutation and signature configs", () => {
  const app = createFFCATest<
    TestStorageConfig,
    CounterMutationsConfig,
    CounterSignatureConfig
  >();

  type Input = Parameters<typeof app.execute>[0];

  expectTypeOf<Input>().toEqualTypeOf<
    FFCAMutationInput<CounterMutationsConfig, CounterSignatureConfig>
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
    name: "newAccount",
    params: { keyType: 2, publicKey: "0x" as Hex },
    signature,
  } satisfies Input;
  const addInput = {
    name: "add",
    params: { amount: 1n, nonce: 0n },
    signature,
  } satisfies Input;

  expectTypeOf(newAccountInput).toMatchTypeOf<
    Extract<Input, { name: "newAccount" }>
  >();
  expectTypeOf(addInput).toMatchTypeOf<Extract<Input, { name: "add" }>>();

  const acceptInput = (_input: Input) => {};

  acceptInput({
    name: "add",
    // @ts-expect-error `add` must use the `add` ABI params, not `newAccount` params.
    params: { keyType: 2, publicKey: "0x" as Hex },
    signature,
  });

  acceptInput({
    name: "newAccount",
    params: { keyType: 2, publicKey: "0x" as Hex },
    // @ts-expect-error `newAccount` must use Counter's configured signature shape.
    signature: { rawSignature: "0x" as Hex },
  });
});

test("FFCA execute input uses manually supplied Harness mutation and signature configs", () => {
  const app = createFFCATest<
    TestStorageConfig,
    HarnessMutationsConfig,
    HarnessSignatureConfig
  >();

  type Input = Parameters<typeof app.execute>[0];

  expectTypeOf<Input>().toEqualTypeOf<
    FFCAMutationInput<HarnessMutationsConfig, HarnessSignatureConfig>
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
    name: "debit",
    params: {
      account: "0x" as Hex,
      keyId: 0n,
      amount: 1n,
      nonce: 0n,
    },
    signature,
  } satisfies Input;

  expectTypeOf(debitInput).toMatchTypeOf<Extract<Input, { name: "debit" }>>();

  const acceptInput = (_input: Input) => {};

  acceptInput({
    name: "debit",
    // @ts-expect-error `debit` requires the Harness debit ABI params.
    params: { rootKeyType: 2, rootPublicKey: "0x" as Hex },
    signature,
  });
});

test("FFCA sequencing type is represented in the app type", () => {
  const app = createFFCATest<
    TestStorageConfig,
    CounterMutationsConfig,
    CounterSignatureConfig,
    "batch"
  >();

  expectTypeOf(app).toEqualTypeOf<
    FFCA<
      TestStorageConfig,
      CounterMutationsConfig,
      CounterSignatureConfig,
      "batch"
    >
  >();
});
