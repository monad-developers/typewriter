# CLAUDE.md — order-book-contracts

Solidity (Foundry). `Exchange.sol` + `Account.sol`. Batched execution via a privileged scheduler, EIP-712 signed mutations, P-256/WebAuthn/secp256k1 keys with permission masks, parallel-nonce account model, and a force-exit queue so users can bypass the scheduler.

## Foundry nightly required

`foundryup --install nightly`. The Exchange uses the P-256 precompile at `address(0x100)` (RIP-7212), which stable Foundry (1.5.1) does not include. Both `forge test` and `anvil` need the nightly build.

## Tests

```bash
forge test
forge test --match-test testFillsAtUniformPrice
forge test -vvv                                   # traces on failure
```
