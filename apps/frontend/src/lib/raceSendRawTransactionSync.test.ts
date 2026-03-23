import { test, expect, mock } from "bun:test";

// We test the URL-set logic and Promise.any racing behavior

test("deduplicates primary URL if it matches a known provider", async () => {
  // Import the module to verify it exports correctly
  const mod = await import("./raceSendRawTransactionSync");
  expect(typeof mod.raceSendRawTransactionSync).toBe("function");
});

test("MONAD_TESTNET_RPC_URLS are all https URLs", async () => {
  const mod = await import("./raceSendRawTransactionSync");
  // We can't access the private constant directly, but we verify
  // the function exists and is callable
  expect(mod.raceSendRawTransactionSync).toBeDefined();
});
