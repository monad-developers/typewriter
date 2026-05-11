import { expect, test } from "bun:test";
import { formatStoragePath, parseStoragePath } from "./storage-path";

test("parseStoragePath round-trips human-readable paths", () => {
  const path = parseStoragePath(
    'accounts[0xabcd].orders[3].metadata["lastUpdate"]',
  );

  expect(path).toMatchInlineSnapshot(`
    {
      "root": "accounts",
      "segments": [
        {
          "kind": "subscript",
          "value": {
            "kind": "hex",
            "value": "0xabcd",
          },
        },
        {
          "kind": "field",
          "name": "orders",
        },
        {
          "kind": "subscript",
          "value": {
            "kind": "number",
            "value": 3n,
          },
        },
        {
          "kind": "field",
          "name": "metadata",
        },
        {
          "kind": "subscript",
          "value": {
            "kind": "string",
            "value": "lastUpdate",
          },
        },
      ],
    }
  `);
  expect(formatStoragePath(path)).toBe(
    'accounts[0xabcd].orders[3].metadata["lastUpdate"]',
  );
});
