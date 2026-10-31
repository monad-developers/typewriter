# Order Book Contracts

The on-chain order book and account contracts. Batch execution via a privileged scheduler, EIP-712 signed mutations, P256/WebAuthn/secp256k1 keys with permission masks, parallel-nonce account model, and a force-exit queue so users can bypass the scheduler. See the in-app `/about` page for the architectural walkthrough.

Within each batch, mutations are sequenced cancel → limit → market and market orders clear at a uniform price.

## Prerequisites

[Latest Foundry](https://book.getfoundry.sh/getting-started/installation) with Monad network support. The latest release includes the P256 precompile at `address(0x100)` (RIP-7212) and does not require a separate category-labs Foundry build. Local development needs no deploy: `bun dev` starts its own Anvil and deploys the contract to it.

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `PRIVATE_KEY` | Yes (for deploy) | Private key used to deploy the contract and derive the scheduler address |
| `RPC_URL` | Yes (for deploy) | JSON-RPC endpoint to deploy to |

Order-book uses one root `.env` file. To deploy to Monad testnet, copy `.env.example.testnet` to `.env` in `apps/order-book`, set `PRIVATE_KEY`, then run `bun run deploy`.

## Usage

```shell
bun install
forge test --network monad # from this contracts directory
forge snapshot --network monad # from this contracts directory, updates .gas-snapshot
bun run contracts:build
bun run deploy      # from apps/order-book, deploy to the RPC in .env
```

The pre-Typewriter Foundry tests have been reconciled into `test/` and run against the Typewriter-backed contract surface.
