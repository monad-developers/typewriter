import { expect, test } from "bun:test";
import { layout, OWNER } from "../test/utils";
import { resolveStoragePath } from "./storage-layout";

test("resolveStoragePath gives the canonical selector", () => {
  expect(
    resolveStoragePath(
      layout,
      `allowances[ ${OWNER.toUpperCase().replace("0X", "0x")} ][${OWNER}]`,
    ).selector,
  ).toBe(`allowances[0x1111111111111111111111111111111111111234][${OWNER}]`);
  expect(resolveStoragePath(layout, "dynamicNumbers[0x0a]").selector).toBe(
    "dynamicNumbers[0x0a]",
  );
  expect(resolveStoragePath(layout, "metadata.inner.count").selector).toBe(
    "metadata.inner.count",
  );
});

test("resolveStoragePath rejects malformed selectors", () => {
  expect(() => resolveStoragePath(layout, "")).toThrow(
    "expected identifier in storage path: ",
  );
  expect(() => resolveStoragePath(layout, "metadata.")).toThrow(
    "expected identifier in storage path: metadata.",
  );
  expect(() => resolveStoragePath(layout, "balances[0x1")).toThrow(
    "unterminated subscript in storage path: balances[0x1",
  );
  expect(() => resolveStoragePath(layout, "balances[ ]")).toThrow(
    "storage path subscript cannot be empty",
  );
  expect(() => resolveStoragePath(layout, "balances[abc]")).toThrow(
    "unsupported storage path subscript: abc",
  );
  expect(() => resolveStoragePath(layout, "totalSupply!")).toThrow(
    "unexpected '!' in storage path: totalSupply!",
  );
});
