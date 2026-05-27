# FFCA

Full stack framework for building crypto apps.

- **Custom sequencing**. Applications define their transaction ordering (fifo, frequent batch, or any rule it chooses).
- **Sub-block confirmations**. Applications can issue responses in milliseconds, before transactions finalize onchain.
- **Modern signature primitives**. EIP-712 plus native P-256, WebAuthn-P256, and secp256k1 verification; apps define their own account policy.
- **Minimal dependencies**. No external relayers, sequencers, or builder auctions between users and the application. The application has end-to-end control over what users experience.
- **Local first**. Build rapidly with a powerful local development loop.

> This project is under active development. Not ready for production use.

## Concepts

### State

Application state lives onchain, where the Solidity state definition serves as the ground truth.

```sol
struct State {
    uint256 totalSupply;
    mapping(bytes32 => Account) accounts;
}
```

### Mutations

Updates to application state are done with mutations. Mutations are app-defined state transistions requested by a user and executed onchain.

```sol
struct Transfer {
    bytes32 from;
    bytes32 to;
    uint256 amount;
}

function executeTransfer(State storage state, Transfer calldata transfer) {
    state.account[tranfer.from].balance -= transfer.amount;
    unchecked {
        state.account[transfer.to].balance += transfer.amount;
    }
}
```

A mutation is the framework equivalent of a transaction, but unlike transactions, they are not submitted directly onchain. Instead mutations are submitted to the application server where they can be reordered and accepted quickly, then eventually made durable with onchain execution.

The lifecycle of a mutation is as follows:
- **received**. The server has received the mutation.
- **accepted**. The server has ordered and executed the mutation locally.
- **included**. The server submitted the mutation onchain and it has been included in a block.
- **safe**. The block that contains the mutation has been marked "safe" by consensus. (See JSON-RPC "safe" tag).
- **finalized**. The block that contains the mutation has been marked "finalized" by consensus. (See JSON-RPC "finalized" tag).

Some mutations can be executed directly from their submitted arguments, others need resolution with a more complete state view. For example, a transfer may only need `{ from, to, amount }`. A matching engine may need to compute fills based on the current order book. That extra computed data is the mutation's resolution.

```sol
struct MarketOrder {
    uint256 quanity;
    uint256 minReceivedQuantity;
    uint64 instrumentId;
    uint8 bidOrAsk;
}

struct MarketOrderResolution {
    Fill[] fills;
}

struct Fill {
    uint256 quantity;
    uint256 price;
}

function executeMarketOrder(State storage state, MarketOrder calldata marketOrder, MarketOrderResolution calldata resolution) {
    // ...
}
```

### Accounts and Signatures

The account system is built-in. All apps have accounts.

FFCA requires mutations to be signed with EIP-712 typed data. The runtime builds the digest from the configured domain, mutation name, and mutation arguments; clients do not supply the digest directly.

FFCA supports three signature algorithms:

- P-256
- WebAuthn-P256
- secp256k1

The framework owns the EIP-712 digest construction, calldata encoding, and native signature verification primitives for those algorithms. Apps own account policy.

`Account` and `Signature` structs are app-defined. The `Signature` struct must include `keyType: uint8` and `rawSignature: bytes`, declared through `FFCAConfig.signature.params`. Apps add whatever other fields their contract expects, such as `account`, `keyId`, nonce metadata, or permission scope.

Account registry shape, key lookup, nonce policy, expiry/deadline checks, bootstrap mutations, and permissions are left up to users to implement in their app and contract.

### Sequencing

Sequencing controls the order mutations are accepted by the server and included onchain. FFCA ships two sequencing modes: FIFO and batch.

A mutation is `accepted` once the server has assigned it a position in the local execution order and run it against local state (see [Mutations](#mutations)). When a mutation is submitted with `ffca.execute()`, FFCA places it in an order relative to other mutations submitted around the same time. Mutations are written onchain in groups on a fixed interval, not one at a time.

#### FIFO

```ts
sequencing: {
  order: "fifo",
  submitIntervalMs: 400, // default (ms)
}
```

Each call to `ffca.execute()` immediately executes the mutation against local state and returns the accepted mutation, or throws an error if the mutation is rejected. Every `submitIntervalMs`, all accepted mutations are submitted with a single onchain transaction.

Onchain inclusion order matches the order mutations were executed with `ffca.execute()`.

#### Batch

```ts
sequencing: {
  order: "batch",
  batchIntervalMs: 50,   // default (ms)
  submitIntervalMs: 400, // default (ms)
  batchOrder: ["CancelOrder", "LimitOrder", "MarketOrder"],
}
```

Each call to `ffca.execute()` enqueues the mutation and returns the accepted mutation once the next batch is processed, or throws an error if the mutation is rejected. Every `batchIntervalMs`, all enqueued mutations are gathered into a batch, ordered according to `batchOrder`, and accepted or rejected. Every `submitIntervalMs`, all batches are submitted with a single onchain transaction.

Within a batch, mutations execute in `batchOrder`; across batches, batches are submitted in the order they were accepted.

## Examples

- [`token`](../../apps/token) is a minimal token application that demonstrates FIFO mutation sequencing, account-owned transfers, and the smallest practical FFCA app shape.
- [`order-book`](../../apps/order-book) is a full exchange application with custom sequencing, WebAuthn account bootstrap, session keys, deposits, withdrawals, and onchain settlement.

## Failure modes

### Reorg handling

A mutation can be included in a block and later removed by a [chain reorganization](https://www.alchemy.com/overviews/what-is-a-reorg). By definition, this only affects mutations that have not reached the `finalized` state.

Reorgs are detected on the server by requesting new blocks with JSON-RPC requests and reconciling them into the local view of the chain. The specific algorithm used to detect reorgs is inspired by [Ponder](https://github.com/ponder-sh/ponder), where it has been used in production for millions of hours, cumulatively.

When a reorg is detected, mutations may move backwards in the mutation lifecycle (submitted => accepted => included => safe => finalized). They are re-processed against the new canonical chain and re-emitted with their updated lifecycle status.

> Coming soon: As a protection against exposing user-facing data that may be reorged, apps can choose to use later lifecycle stages, such as `"included"`, `"safe"`, or `"finalized"`, to serve read requests.

### Force inclusion

Users can bypass the server entirely and submit their mutations directly to the chain with _force inclusion_. Force inclusion is not meant to replace server-based mutation processing during normal operation. It exists as an escape hatch so that a valid mutation cannot be censored indefinitely.

Force inclusion uses a two-stage, enqueue then execute, mechanism. First, a user registers their mutation onchain by calling the `enqueue()` function.

When the server detects a force-included mutation, it reconciles the force included mutation with its local state view, then includes the mutation onchain.

If the server is completely offline, the user may execute their queued mutation after the `FORCE_INCLUSION_DELAY`.

### Offchain/onchain divergence

Mutations are executed and accepted on the server before they are executed onchain. Onchain divergence happens when the server's local execution environment accepts a mutation, but the same mutation behaves differently (and reverts) when executed onchain.

This can happen when the execution depends on EVM environment opcodes whose values differ from the values used in the mined transaction.

When a server-submitted transaction reverts, "accepted" mutations may move backwards in the mutation lifecycle (to "received"). They are re-processed against the current canonical chain state and re-emitted with their updated lifecycle status. From the user's perspective, this is no different than a chain reorgization.

The server execution environment uses values from the last known block for EVM environment opcodes. Certain EVM environment opcodes, such as `COINBASE` or `PREVRANDAO`, can make divergence more likely or even guaranteed. For a full list of unsupported opcodes, see [contract requirements](#contract-requirements).

> Coming soon: If onchain execution results in a different state transition than the server accepted, the transaction will revert instead of settling a mismatched result.

### Crash recovery

## API reference

### Contract requirements

Conformance

`block.miner`
`block.difficulty`

### `createFFCA()`

### `ffca.execute()`

### `ffca.state`

### `ffca.domain`

### `ffca.on()`

### `verifySignature()`

### Server persistence
