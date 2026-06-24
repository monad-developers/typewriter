import { expect, test } from "bun:test";
import { anvil } from "viem/chains";
import OrderBook from "../../../apps/order-book/contracts/src/OrderBook.sol";
import Token from "../../../apps/token/contracts/src/Token.sol";
import Counter from "../test/contracts/src/Counter.sol";
import Harness from "../test/contracts/src/Harness.sol";
import InvalidEntrypoint from "../test/contracts/src/InvalidEntrypoint.sol";
import MultipleEntrypoints from "../test/contracts/src/MultipleEntrypoints.sol";
import NestedParam from "../test/contracts/src/NestedParam.sol";
import {
  SCHEDULER_ACCOUNT,
  TEST_DB_URL,
  TEST_RPC_URL,
  USER_ACCOUNT,
  USER_PRIVATE_KEY,
} from "../test/setup";
import {
  counterNewAccountMutation,
  deployCounter,
  signCounter,
} from "../test/utils";
import { createTypewriter, type TypewriterConfig } from "./index";
import { formatSolidityDeclaration, parseSolidityMetadata } from "./sol-parse";

test("parseSolidityMetadata extracts Counter runtime metadata", async () => {
  const metadata = await parseSolidityMetadata(Counter);

  expect({
    contractName: metadata.contractName,
    abiErrors: metadata.abi
      .filter((item) => item.type === "error")
      .map((item) => item.name)
      .sort(),
    storageLabels: metadata.storageLayout.storage.map((entry) => entry.label),
    storageSlots: metadata.storageLayout.storage.map((entry) => entry.slot),
    signature: metadata.signature.params,
    mutations: metadata.mutations,
  }).toMatchInlineSnapshot(`
    {
      "abiErrors": [
        "AccountExists",
        "ForceInclusionAlreadyExecuted",
        "ForceInclusionTooEarly",
        "InvalidNonce",
        "InvalidSignature",
        "LengthMismatch",
        "UnauthorizedExecute",
        "UnknownMutation",
      ],
      "contractName": "Counter",
      "mutations": [
        {
          "enumName": "NewAccount",
          "params": [
            {
              "name": "keyType",
              "type": "uint8",
            },
            {
              "name": "publicKey",
              "type": "bytes",
            },
          ],
          "tag": 0,
        },
        {
          "enumName": "Add",
          "params": [
            {
              "name": "amount",
              "type": "uint256",
            },
            {
              "name": "nonce",
              "type": "uint256",
            },
          ],
          "tag": 1,
        },
      ],
      "signature": [
        {
          "name": "accountId",
          "type": "bytes32",
        },
        {
          "name": "publicKey",
          "type": "bytes",
        },
        {
          "name": "rawSignature",
          "type": "bytes",
        },
      ],
      "storageLabels": [
        "total",
        "accounts",
      ],
      "storageSlots": [
        "2",
        "3",
      ],
    }
  `);
});

test("parseSolidityMetadata extracts Harness runtime metadata", async () => {
  const metadata = await parseSolidityMetadata(Harness);

  expect({
    contractName: metadata.contractName,
    storageLabels: metadata.storageLayout.storage.map((entry) => entry.label),
    signature: metadata.signature.params,
    mutations: metadata.mutations.map((mutation) => ({
      name: mutation.enumName,
      tag: mutation.tag,
      params: mutation.params,
    })),
  }).toMatchInlineSnapshot(`
    {
      "contractName": "Harness",
      "mutations": [
        {
          "name": "Initialize",
          "params": [
            {
              "name": "rootKeyType",
              "type": "uint8",
            },
            {
              "name": "rootPublicKey",
              "type": "bytes",
            },
          ],
          "tag": 0,
        },
        {
          "name": "Authorize",
          "params": [
            {
              "name": "account",
              "type": "bytes32",
            },
            {
              "name": "keyId",
              "type": "uint64",
            },
            {
              "name": "keyType",
              "type": "uint8",
            },
            {
              "name": "publicKey",
              "type": "bytes",
            },
            {
              "name": "nonce",
              "type": "uint256",
            },
          ],
          "tag": 1,
        },
        {
          "name": "Credit",
          "params": [
            {
              "name": "account",
              "type": "bytes32",
            },
            {
              "name": "keyId",
              "type": "uint64",
            },
            {
              "name": "amount",
              "type": "uint256",
            },
            {
              "name": "nonce",
              "type": "uint256",
            },
          ],
          "tag": 2,
        },
        {
          "name": "Debit",
          "params": [
            {
              "name": "account",
              "type": "bytes32",
            },
            {
              "name": "keyId",
              "type": "uint64",
            },
            {
              "name": "amount",
              "type": "uint256",
            },
            {
              "name": "nonce",
              "type": "uint256",
            },
          ],
          "tag": 3,
        },
        {
          "name": "Assert",
          "params": [
            {
              "name": "account",
              "type": "bytes32",
            },
            {
              "name": "keyId",
              "type": "uint64",
            },
            {
              "name": "expected",
              "type": "uint256",
            },
            {
              "name": "nonce",
              "type": "uint256",
            },
          ],
          "tag": 4,
        },
      ],
      "signature": [
        {
          "name": "account",
          "type": "bytes32",
        },
        {
          "name": "keyId",
          "type": "uint64",
        },
        {
          "name": "keyType",
          "type": "uint8",
        },
        {
          "name": "rawSignature",
          "type": "bytes",
        },
      ],
      "storageLabels": [
        "accounts",
        "balances",
      ],
    }
  `);
});

test("parseSolidityMetadata extracts Token runtime metadata", async () => {
  const metadata = await parseSolidityMetadata(Token);

  expect({
    contractName: metadata.contractName,
    storageLabels: metadata.storageLayout.storage.map((entry) => entry.label),
    signature: metadata.signature.params,
    mutations: metadata.mutations,
  }).toMatchInlineSnapshot(`
    {
      "contractName": "Token",
      "mutations": [
        {
          "enumName": "Transfer",
          "params": [
            {
              "name": "from",
              "type": "address",
            },
            {
              "name": "to",
              "type": "address",
            },
            {
              "name": "amount",
              "type": "uint256",
            },
            {
              "name": "nonce",
              "type": "uint256",
            },
            {
              "name": "deadline",
              "type": "uint256",
            },
          ],
          "tag": 0,
        },
        {
          "enumName": "Mint",
          "params": [
            {
              "name": "to",
              "type": "address",
            },
            {
              "name": "amount",
              "type": "uint256",
            },
            {
              "name": "nonce",
              "type": "uint256",
            },
            {
              "name": "deadline",
              "type": "uint256",
            },
          ],
          "tag": 1,
        },
      ],
      "signature": [
        {
          "name": "keyType",
          "type": "uint8",
        },
        {
          "name": "rawSignature",
          "type": "bytes",
        },
      ],
      "storageLabels": [
        "totalSupply",
        "accounts",
      ],
    }
    `);
}, 20_000);

test("generated Token Solidity declaration matches committed artifact", async () => {
  const metadata = await parseSolidityMetadata(Token);
  const declaration = await Bun.file(
    new URL(
      "../../../apps/token/contracts/src/Token.sol.d.ts",
      import.meta.url,
    ),
  ).text();

  expect(formatSolidityDeclaration(metadata)).toBe(declaration);
}, 20_000);

test("parseSolidityMetadata extracts OrderBook runtime metadata", async () => {
  const metadata = await parseSolidityMetadata(OrderBook);

  expect({
    contractName: metadata.contractName,
    storageLabels: metadata.storageLayout.storage.map((entry) => entry.label),
    signature: metadata.signature.params,
    mutations: metadata.mutations.map((mutation) => ({
      name: mutation.enumName,
      tag: mutation.tag,
      params: mutation.params.map((param) => `${param.name}:${param.type}`),
    })),
  }).toMatchInlineSnapshot(`
    {
      "contractName": "OrderBook",
      "mutations": [
        {
          "name": "Initialize",
          "params": [
            "account:bytes32",
            "expiry:uint40",
            "rootKeyType:uint8",
            "keyType:uint8",
            "permissions:uint16",
            "rootPublicKey:bytes",
            "publicKey:bytes",
          ],
          "tag": 0,
        },
        {
          "name": "Authorize",
          "params": [
            "account:bytes32",
            "expiry:uint40",
            "keyType:uint8",
            "permissions:uint16",
            "publicKey:bytes",
            "nonce:uint256",
            "deadline:uint256",
          ],
          "tag": 1,
        },
        {
          "name": "Revoke",
          "params": [
            "account:bytes32",
            "keyId:uint64",
            "nonce:uint256",
            "deadline:uint256",
          ],
          "tag": 2,
        },
        {
          "name": "CloseOrder",
          "params": [
            "orderId:uint64",
            "nonce:uint256",
            "deadline:uint256",
          ],
          "tag": 3,
        },
        {
          "name": "ChangeOrder",
          "params": [
            "orderId:uint64",
            "price:uint64",
            "nonce:uint256",
            "deadline:uint256",
          ],
          "tag": 4,
        },
        {
          "name": "LimitOrder",
          "params": [
            "quantity:uint256",
            "instrumentId:uint64",
            "price:uint64",
            "bidOrAsk:uint8",
            "nonce:uint256",
            "deadline:uint256",
          ],
          "tag": 5,
        },
        {
          "name": "MarketOrder",
          "params": [
            "quantity:uint256",
            "minReceivedQuantity:uint256",
            "instrumentId:uint64",
            "bidOrAsk:uint8",
            "nonce:uint256",
            "deadline:uint256",
          ],
          "tag": 6,
        },
        {
          "name": "AddInstrument",
          "params": [
            "instrumentId:uint64",
            "base:address",
            "quote:address",
            "baseLotExp:uint8",
            "quoteLotExp:uint8",
            "nonce:uint256",
            "deadline:uint256",
          ],
          "tag": 7,
        },
        {
          "name": "Deposit",
          "params": [
            "asset:address",
            "amount:uint256",
            "nonce:uint256",
            "deadline:uint256",
          ],
          "tag": 8,
        },
        {
          "name": "Withdrawal",
          "params": [
            "asset:address",
            "amount:uint256",
            "nonce:uint256",
            "deadline:uint256",
          ],
          "tag": 9,
        },
      ],
      "signature": [
        {
          "name": "account",
          "type": "bytes32",
        },
        {
          "name": "keyId",
          "type": "uint64",
        },
        {
          "name": "rawSignature",
          "type": "bytes",
        },
      ],
      "storageLabels": [
        "accounts",
        "instruments",
      ],
    }
    `);
}, 20_000);

test("generated OrderBook Solidity declaration matches committed artifact", async () => {
  const metadata = await parseSolidityMetadata(OrderBook);
  const declaration = await Bun.file(
    new URL(
      "../../../apps/order-book/contracts/src/OrderBook.sol.d.ts",
      import.meta.url,
    ),
  ).text();

  expect(formatSolidityDeclaration(metadata)).toBe(declaration);
}, 20_000);

test("parseSolidityMetadata errors when no contract inherits Typewriter", async () => {
  await expect(parseSolidityMetadata(InvalidEntrypoint)).rejects.toThrow(
    "InvalidEntrypoint.sol does not contain a contract inheriting Typewriter",
  );
});

test("parseSolidityMetadata errors when multiple contracts inherit Typewriter", async () => {
  await expect(parseSolidityMetadata(MultipleEntrypoints)).rejects.toThrow(
    "MultipleEntrypoints.sol contains multiple contracts inheriting Typewriter: FirstEntrypoint, SecondEntrypoint",
  );
});

test("parseSolidityMetadata errors when the entrypoint is not a string", async () => {
  await expect(
    parseSolidityMetadata(42 as unknown as typeof Counter),
  ).rejects.toThrow(
    "Typewriter entrypoint must be a Solidity file path string",
  );
});

test("parseSolidityMetadata errors when the entrypoint file does not exist", async () => {
  await expect(
    parseSolidityMetadata("/tmp/does-not-exist/Missing.sol" as typeof Counter),
  ).rejects.toThrow("Typewriter entrypoint file does not exist");
});

// Known limitation: mutation params are restricted to elementary types, enums,
// and arrays of those. A struct member that is itself a struct currently throws
// `unsupported Solidity type` instead of being parsed into a tuple ABI param.
// This test documents the desired behavior and is expected to fail until nested
// struct params are supported; once they are, `test.failing` flags it so it can
// be promoted to a regular `test`.
test.failing("parseSolidityMetadata parses nested struct mutation params as tuples", async () => {
  const metadata = await parseSolidityMetadata(NestedParam);
  const update = metadata.mutations.find(
    (mutation) => mutation.enumName === "Update",
  );

  expect(update?.params).toEqual([
    {
      name: "inner",
      type: "tuple",
      components: [
        { name: "a", type: "uint256" },
        { name: "b", type: "uint256" },
      ],
    },
    { name: "nonce", type: "uint256" },
  ]);
});

test("createTypewriter accepts an imported Solidity entrypoint", async () => {
  const address = await deployCounter(USER_ACCOUNT.address);
  const typewriter = await createTypewriter(Counter, {
    address,
    account: SCHEDULER_ACCOUNT,
    chainId: anvil.id,
    rpcUrl: TEST_RPC_URL,
    database: { url: TEST_DB_URL, maxConnections: 2 },
    sequencing: {
      order: "batch",
      batchOrder: ["NewAccount", "Add"],
      batchIntervalMs: 50,
      submitIntervalMs: 25,
    },
  } satisfies TypewriterConfig<"batch">);

  try {
    await typewriter.execute(
      counterNewAccountMutation({
        address: USER_ACCOUNT.address,
      }) as unknown as Parameters<typeof typewriter.execute>[0],
    );
    await typewriter.execute({
      name: "Add",
      params: { amount: 3n, nonce: 0n },
      signature: signCounter({
        privateKey: USER_PRIVATE_KEY,
        amount: 3n,
        nonce: 0n,
        address,
        chainId: anvil.id,
      }),
    });
  } finally {
    await typewriter.close();
  }
});
