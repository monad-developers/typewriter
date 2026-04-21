# Order Book Contracts

On-chain order book with batch execution via a scheduler. Cancels are processed before orders within each batch (priority ordering). Market orders receive uniform price within a batch.

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `DEPLOYER_PRIVATE_KEY` | Yes (for deploy) | Private key used to deploy the contract |
| `RPC_URL` | Yes (for deploy) | JSON-RPC endpoint to deploy to |
| `SCHEDULER_ADDRESS` | Yes (for deploy) | Address authorized to call `execute()` |

Copy `.env.example.local` or `.env.example.testnet` to `.env`.

## Usage

```shell
bun install
bun run build       # forge build
bun run dev         # anvil + auto-deploy
bun run deploy      # deploy to configured RPC
```
