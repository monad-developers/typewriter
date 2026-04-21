import { afterAll, beforeAll, expect, test } from "bun:test";
import { createEVM, type EVM } from "./index";

const CONTRACT = "0x0000000000000000000000000000000000000042" as const;
const CALLER = "0x1111111111111111111111111111111111111111" as const;

// Minimal bytecode: PUSH1 0xaa, PUSH1 0x00, SSTORE, STOP
const STORAGE_WRITER = "0x60aa60005500" as const;

let evm: EVM;

beforeAll(async () => {
  evm = await createEVM({
    spec: "MonadEight",
    accounts: {
      [CONTRACT]: { code: STORAGE_WRITER },
      [CALLER]: { balance: 10n ** 24n },
    },
  });
});

afterAll(async () => {
  await evm.close();
});

test("execute runs and reports a storage diff", async () => {
  const result = await evm.execute({
    from: CALLER,
    to: CONTRACT,
    data: "0x",
  });

  expect(result).toMatchInlineSnapshot(`
    {
      "accessList": [
        {
          "address": "0x0000000000000000000000000000000000000000",
          "storageKeys": [],
        },
        {
          "address": "0x0000000000000000000000000000000000000042",
          "storageKeys": [
            "0x0000000000000000000000000000000000000000000000000000000000000000",
          ],
        },
        {
          "address": "0x1111111111111111111111111111111111111111",
          "storageKeys": [],
        },
      ],
      "gasUsed": 49106,
      "output": "0x",
      "post": {
        "0x0000000000000000000000000000000000000042": {
          "storage": {
            "0x0000000000000000000000000000000000000000000000000000000000000000": "0x00000000000000000000000000000000000000000000000000000000000000aa",
          },
        },
        "0x1111111111111111111111111111111111111111": {
          "nonce": 1,
        },
      },
      "pre": {
        "0x0000000000000000000000000000000000000042": {
          "storage": {
            "0x0000000000000000000000000000000000000000000000000000000000000000": "0x0000000000000000000000000000000000000000000000000000000000000000",
          },
        },
        "0x1111111111111111111111111111111111111111": {
          "nonce": 0,
        },
      },
      "revertReason": undefined,
      "success": true,
    }
  `);
});

test("a second execute continues from the committed state", async () => {
  const result = await evm.execute({
    from: CALLER,
    to: CONTRACT,
    data: "0x",
  });

  expect(result).toMatchInlineSnapshot(`
    {
      "accessList": [
        {
          "address": "0x0000000000000000000000000000000000000000",
          "storageKeys": [],
        },
        {
          "address": "0x0000000000000000000000000000000000000042",
          "storageKeys": [
            "0x0000000000000000000000000000000000000000000000000000000000000000",
          ],
        },
        {
          "address": "0x1111111111111111111111111111111111111111",
          "storageKeys": [],
        },
      ],
      "gasUsed": 29206,
      "output": "0x",
      "post": {
        "0x1111111111111111111111111111111111111111": {
          "nonce": 2,
        },
      },
      "pre": {
        "0x1111111111111111111111111111111111111111": {
          "nonce": 1,
        },
      },
      "revertReason": undefined,
      "success": true,
    }
  `);
});
