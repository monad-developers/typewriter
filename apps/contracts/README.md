# contracts

ERC20 token contract built with [Foundry](https://book.getfoundry.sh/) and [Solmate](https://github.com/transmissions11/solmate).

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `RPC_URL` | Yes (for deploy) | JSON-RPC endpoint to deploy to |
| `TOKEN_NAME` | Yes (for deploy) | Name of the ERC20 token |
| `TOKEN_SYMBOL` | Yes (for deploy) | Symbol of the ERC20 token |
| `TOKEN_DECIMALS` | Yes (for deploy) | Decimals for the ERC20 token |

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

This runs Anvil with a 0.4s block time and deploys the token using the first Anvil account.

### Deploy

Deploy to a custom RPC endpoint:

```shell
TOKEN_NAME="Hi Kevin" TOKEN_SYMBOL="HK" TOKEN_DECIMALS=18 \
  forge script script/Token.s.sol:TokenScript \
  --broadcast --rpc-url $RPC_URL \
  --private-key <your_private_key>
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
