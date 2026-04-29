# token-contracts

ERC20 token contract built with [Foundry](https://book.getfoundry.sh/) and [Solmate](https://github.com/transmissions11/solmate).

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `DEPLOYER_PRIVATE_KEY` | Yes (for deploy) | Private key used to deploy the contract |
| `RPC_URL` | Yes (for deploy) | JSON-RPC endpoint to deploy to |

Copy `.env.example.local` or `.env.example.testnet` to `.env`. The deploy script sources `.env` automatically.

## Usage

### Build

```shell
forge build
```

### Test

```shell
forge test
```

### Format

```shell
forge fmt
```

### Local Development

Start a local Anvil node and auto-deploy the token:

```shell
bun run dev
```

This runs Anvil and deploys the token using the deployer key from `.env`.

### Deploy

Deploy to a custom RPC endpoint (set `DEPLOYER_PRIVATE_KEY` and `RPC_URL` in `.env`):

```shell
bun run deploy
```

### Gas Snapshots

```shell
forge snapshot
```

### Help

```shell
forge --help
anvil --help
cast --help
```
