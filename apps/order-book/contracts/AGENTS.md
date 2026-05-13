# AGENTS.md — order-book/contracts

Solidity (Foundry). FFCA-backed `Exchange.sol` plus account primitives imported from `packages/ffca`. Batched execution via a privileged scheduler, EIP-712 signed mutations, P-256/WebAuthn/secp256k1 keys with permission masks, parallel-nonce account model, and a force-exit queue so users can bypass the scheduler.

## Foundry nightly required

`foundryup --install nightly`. The Exchange uses the P-256 precompile at `address(0x100)` (RIP-7212), which stable Foundry (1.5.1) does not include. Both `forge test` and `anvil` need the nightly build.

## Tests

```bash
forge test
forge test --match-test testFillsAtUniformPrice
forge test -vvv                                   # traces on failure
```

Run package scripts from `apps/order-book`: `bun run contracts:build`, `bun run contracts:lint`, and `bun run deploy`.

The pre-FFCA contract tests have been reconciled into `test/`; keep new contract behavior covered there.
