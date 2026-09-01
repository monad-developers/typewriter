import { expect, test } from "bun:test";
import { anvil } from "viem/chains";
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
  USER_PRIVATE_KEY,
} from "../test/setup";
import {
  deployCounter,
  prepareCounterAdd,
  prepareCounterCreateAccount,
} from "../test/utils";
import { createTypewriter, type TypewriterConfig } from "./index";
import { formatSolidityDeclaration, parseSolidityMetadata } from "./sol-parse";

function summarizeMutations(
  mutations: Awaited<ReturnType<typeof parseSolidityMetadata>>["mutations"],
) {
  return mutations.map((mutation) => ({
    name: mutation.enumName,
    id: mutation.id,
    params: mutation.params.map((param) => `${param.name}:${param.type}`),
  }));
}

test("parseSolidityMetadata extracts Counter native-account metadata", async () => {
  const metadata = await parseSolidityMetadata(Counter);

  expect({
    contractName: metadata.contractName,
    storage: metadata.storageLayout.storage.map(
      (entry) => `${entry.label}:${entry.slot}`,
    ),
    mutations: summarizeMutations(metadata.mutations),
  }).toMatchInlineSnapshot(`
    {
      "contractName": "Counter",
      "mutations": [
        {
          "id": 0,
          "name": "Add",
          "params": [
            "amount:uint256",
          ],
        },
        {
          "id": 253,
          "name": "CreateAccount",
          "params": [
            "keyType:uint8",
            "publicKey:bytes",
          ],
        },
        {
          "id": 254,
          "name": "AddCredential",
          "params": [
            "expiration:uint40",
            "keyType:uint8",
            "permissions:uint256",
            "publicKey:bytes",
          ],
        },
        {
          "id": 255,
          "name": "RemoveCredential",
          "params": [
            "credentialID:uint64",
          ],
        },
      ],
      "storage": [
        "accounts:0",
        "queue:1",
        "executionIndex:2",
        "state:3",
      ],
    }
  `);
});

test("parseSolidityMetadata extracts account-scoped Harness metadata", async () => {
  const metadata = await parseSolidityMetadata(Harness);

  expect({
    contractName: metadata.contractName,
    storageLabels: metadata.storageLayout.storage.map((entry) => entry.label),
    mutations: summarizeMutations(metadata.mutations),
  }).toMatchInlineSnapshot(`
    {
      "contractName": "Harness",
      "mutations": [
        {
          "id": 0,
          "name": "Credit",
          "params": [
            "amount:uint256",
          ],
        },
        {
          "id": 1,
          "name": "Debit",
          "params": [
            "amount:uint256",
          ],
        },
        {
          "id": 2,
          "name": "Assert",
          "params": [
            "expected:uint256",
          ],
        },
        {
          "id": 253,
          "name": "CreateAccount",
          "params": [
            "keyType:uint8",
            "publicKey:bytes",
          ],
        },
        {
          "id": 254,
          "name": "AddCredential",
          "params": [
            "expiration:uint40",
            "keyType:uint8",
            "permissions:uint256",
            "publicKey:bytes",
          ],
        },
        {
          "id": 255,
          "name": "RemoveCredential",
          "params": [
            "credentialID:uint64",
          ],
        },
      ],
      "storageLabels": [
        "accounts",
        "queue",
        "executionIndex",
        "state",
      ],
    }
  `);
});

test("parseSolidityMetadata extracts current Token metadata", async () => {
  const metadata = await parseSolidityMetadata(Token);

  expect({
    contractName: metadata.contractName,
    storageLabels: metadata.storageLayout.storage.map((entry) => entry.label),
    mutations: summarizeMutations(metadata.mutations),
  }).toMatchInlineSnapshot(`
    {
      "contractName": "Token",
      "mutations": [
        {
          "id": 0,
          "name": "Transfer",
          "params": [
            "to:bytes32",
            "amount:uint256",
          ],
        },
        {
          "id": 1,
          "name": "Mint",
          "params": [
            "amount:uint256",
          ],
        },
        {
          "id": 253,
          "name": "CreateAccount",
          "params": [
            "keyType:uint8",
            "publicKey:bytes",
          ],
        },
        {
          "id": 254,
          "name": "AddCredential",
          "params": [
            "expiration:uint40",
            "keyType:uint8",
            "permissions:uint256",
            "publicKey:bytes",
          ],
        },
        {
          "id": 255,
          "name": "RemoveCredential",
          "params": [
            "credentialID:uint64",
          ],
        },
      ],
      "storageLabels": [
        "accounts",
        "queue",
        "executionIndex",
        "state",
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

test("parseSolidityMetadata rejects nested struct mutation params", async () => {
  await expect(parseSolidityMetadata(NestedParam)).rejects.toThrow(
    "unsupported Solidity type",
  );
});

test("createTypewriter accepts an imported Solidity entrypoint", async () => {
  const address = await deployCounter();
  const typewriter = await createTypewriter(Counter, {
    address,
    account: SCHEDULER_ACCOUNT,
    chainId: anvil.id,
    rpcUrl: TEST_RPC_URL,
    database: { url: TEST_DB_URL, maxConnections: 2 },
    sequencing: {
      order: "batch",
      batchOrder: ["CreateAccount", "Add"],
      batchIntervalMs: 50,
      submitIntervalMs: 25,
    },
  } satisfies TypewriterConfig<"batch">);

  try {
    await typewriter.execute(
      await prepareCounterCreateAccount({
        privateKey: USER_PRIVATE_KEY,
        address,
        chainId: anvil.id,
      }),
    );
    await typewriter.execute(
      await prepareCounterAdd({
        privateKey: USER_PRIVATE_KEY,
        amount: 3n,
        sequence: 0n,
        address,
        chainId: anvil.id,
      }),
    );
  } finally {
    await typewriter.close();
  }
});
