import { expectTypeOf, test } from "bun:test";
import type { StorageProxy } from "storage-layout";
import type { Hex } from "viem";
import {
  COUNTER_MUTATIONS,
  COUNTER_SIGNATURE_PARAMS,
  COUNTER_STORAGE_LAYOUT,
  EMPTY_STORAGE_LAYOUT,
  HARNESS_MUTATIONS,
  HARNESS_SIGNATURE_PARAMS,
  HARNESS_STORAGE_LAYOUT,
} from "../test/utils";
import type {
  AbiParametersToValue,
  FFCAConfig,
  MutationsConfig,
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
>(
  config: FFCAConfig<sequencingConfig>,
): FFCA<storageConfig, mutationsConfig, signatureConfig, sequencingConfig> {
  void config;
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

type CounterStorageConfig = typeof COUNTER_STORAGE_LAYOUT;
type CounterMutationsConfig = typeof COUNTER_MUTATIONS;
type CounterSignatureConfig = typeof COUNTER_SIGNATURE_PARAMS;
type HarnessStorageConfig = typeof HARNESS_STORAGE_LAYOUT;
type HarnessMutationsConfig = typeof HARNESS_MUTATIONS;
type HarnessSignatureConfig = typeof HARNESS_SIGNATURE_PARAMS;

const baseConfig = {
  address: "0x0000000000000000000000000000000000000000",
  signature: { params: COUNTER_SIGNATURE_PARAMS },
  // biome-ignore lint/suspicious/noExplicitAny: stub field, types not the focus
  account: {} as any,
  chainId: 1,
  rpcUrl: "http://localhost:8545",
  database: { url: "postgres://postgres@localhost:5432/postgres" },
  storageLayout: EMPTY_STORAGE_LAYOUT,
  domain: { name: "", version: "1" },
} as const;

const counterConfig = {
  ...baseConfig,
  storageLayout: COUNTER_STORAGE_LAYOUT,
  signature: { params: COUNTER_SIGNATURE_PARAMS },
  mutations: COUNTER_MUTATIONS,
} as const satisfies FFCAConfig;

const harnessConfig = {
  ...baseConfig,
  storageLayout: HARNESS_STORAGE_LAYOUT,
  signature: { params: HARNESS_SIGNATURE_PARAMS },
  mutations: HARNESS_MUTATIONS,
} as const satisfies FFCAConfig;

test("FFCAConfig accepts Counter config", () => {
  createFFCATest<
    CounterStorageConfig,
    CounterMutationsConfig,
    CounterSignatureConfig
  >({
    ...counterConfig,
    confirmations: { safeBlockDepth: 2, finalizedBlockDepth: 8 },
  });
});

test("FFCAConfig accepts Harness config", () => {
  createFFCATest<
    HarnessStorageConfig,
    HarnessMutationsConfig,
    HarnessSignatureConfig
  >(harnessConfig);
});

test("FFCA state is typed from manually supplied Counter storage config", () => {
  const app = createFFCATest<
    CounterStorageConfig,
    CounterMutationsConfig,
    CounterSignatureConfig
  >(counterConfig);

  expectTypeOf(app.state).toEqualTypeOf<
    StorageProxy<CounterStorageConfig, true>
  >();
});

test("FFCA execute input uses manually supplied Counter mutation and signature configs", () => {
  const app = createFFCATest<
    CounterStorageConfig,
    CounterMutationsConfig,
    CounterSignatureConfig
  >(counterConfig);

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
    HarnessStorageConfig,
    HarnessMutationsConfig,
    HarnessSignatureConfig
  >(harnessConfig);

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

test("FFCA sequencing type is still inferred from config", () => {
  const app = createFFCATest<
    CounterStorageConfig,
    CounterMutationsConfig,
    CounterSignatureConfig,
    "batch"
  >({
    ...counterConfig,
    sequencing: { order: "batch", batchOrder: ["add"] },
  });

  expectTypeOf(app).toEqualTypeOf<
    FFCA<
      CounterStorageConfig,
      CounterMutationsConfig,
      CounterSignatureConfig,
      "batch"
    >
  >();
});
