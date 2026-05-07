import { beforeAll } from "bun:test";
import { $ } from "bun";

beforeAll(async () => {
  try {
    await $`forge --version`.quiet();
  } catch {
    throw new Error(
      "forge not found on PATH. evm Solidity tests require Foundry — install via `foundryup` (https://book.getfoundry.sh/getting-started/installation).",
    );
  }

  try {
    await $`forge build`.cwd(`${import.meta.dir}/contracts`).quiet();
  } catch (error) {
    throw new Error(`forge build failed:\n${error}`);
  }
});
