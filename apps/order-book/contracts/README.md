# Order Book Contracts

The on-chain exchange and account contracts. Batch execution via a privileged scheduler, EIP-712 signed mutations, P256/WebAuthn/secp256k1 keys with permission masks, parallel-nonce account model, and a force-exit queue so users can bypass the scheduler. See the in-app `/about` page for the architectural walkthrough.

Within each batch, mutations are sequenced cancel → limit → market and market orders clear at a uniform price.

## Prerequisites

[Foundry **nightly**](https://book.getfoundry.sh/getting-started/installation) — `foundryup --install nightly`. The Exchange contract uses the P256 precompile at `address(0x100)` (RIP-7212), which stable Foundry does not include. Required for both `forge test` and `anvil`.

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `PRIVATE_KEY` | Yes (for deploy) | Private key used to deploy the contract and derive the scheduler address |
| `RPC_URL` | Yes (for deploy) | JSON-RPC endpoint to deploy to |

Order-book uses one root `.env` file. From `apps/order-book`, copy `.env.example.local` or `.env.example.testnet` to `.env`, then run `bun run deploy`.

## Usage

```shell
bun install
forge test          # from this contracts directory
bun run contracts:build
bun run deploy      # from apps/order-book, deploy to the RPC in .env
```

The pre-Typewriter Foundry tests have been reconciled into `test/` and run against the Typewriter-backed contract surface.
