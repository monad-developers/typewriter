import { expect, test } from "bun:test";
import type { Hex } from "ox";
import { keccak256 } from "viem";
import { creationCodeHash } from "./deploy";

test("creationCodeHash ignores the trailing solc metadata, and nothing else", () => {
  const code = "0x6080604052";
  const metadata = (hash: string) =>
    `a2646970667358221220${hash.repeat(32)}64736f6c63430008250033`;
  const withMetadata = (hash: string) => `${code}${metadata(hash)}` as Hex.Hex;

  expect(creationCodeHash(withMetadata("11"))).toBe(
    creationCodeHash(withMetadata("22")),
  );
  expect(creationCodeHash(withMetadata("11"))).not.toBe(
    creationCodeHash(`0x6080604053${metadata("11")}`),
  );
  // Code without metadata hashes whole.
  expect(creationCodeHash(code)).toBe(keccak256(code));
  expect(creationCodeHash("0x")).toBe(keccak256("0x"));
});
