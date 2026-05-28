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

function executeTransfer(State storage state, Transfer memory transfer) {
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
import { createFFCA } from "ffca";

const app = createFFCA({
  // ... more config
  sequencing: {
    order: "fifo",
    submitIntervalMs: 400,
  },
});
```

Each call to `ffca.execute()` immediately executes the mutation against local state and returns the accepted mutation, or throws an error if the mutation is rejected. Every `submitIntervalMs`, all accepted mutations are submitted with a single onchain transaction.

Onchain inclusion order matches the order mutations were executed with `ffca.execute()`.

#### Batch

```ts
import { createFFCA } from "ffca";

const app = createFFCA({
  // ... more config
  sequencing: {
    order: "batch",
    batchIntervalMs: 50,
    submitIntervalMs: 400,
    batchOrder: ["CancelOrder", "LimitOrder", "MarketOrder"],
  }
});
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

The server can be restarted at any time without losing accepted state. Every mutatio and raw slot write is persisted to Postgres as it happens. On startup, the runtime rehydrates its local execution environment from the persisted slot writes.

Mutations that were accepted before the crash but had not yet reached `finalized` are reconciled with the underlying chain on restart.

## API reference

### Contract requirements

In order to be FFCA-compliant, a smart contract must written with Solidity and implement certain data structures and methods. 

#### State

All application state is contained in a single `struct State`.

```sol
struct Account {
    KeyType keyType;
    bytes publicKey;
    uint256 nonce;
}

struct State {
    uint256 total;
    mapping(bytes32 accountId => Account) accounts;
}
```

> All Solidity data types are supported, but `mappings` usage must be annotated with `registerMappingKeys()`.

#### Mutations

Each mutation is a Solidity library with:
- **`struct [Mutation]` definition**.
- **`execute[Mutation]` function**. Apply the mutation to the state.
- **`[MUTATION]_TYPEHASH` constant**. EIP 712 typehash of the struct definition.
- **`verify[Mutation]Signature` function**.

```sol
library AddMutation {
    struct Add {
        uint256 amount;
        uint256 nonce;
    }

    bytes32 constant ADD_TYPEHASH = keccak256("add(uint256 amount,uint256 nonce)");

    function verifyAddSignature(State storage state, Add memory add, Signature memory signature, bytes32 digest) external {
        Account storage account = state.accounts[signature.accountId];
        if (account.nonce != add.nonce) revert InvalidNonce();
        verifySignatureMemory(KeyType(account.keyType), digest, account.publicKey, signature.rawSignature);
        account.nonce++;
    }

    function executeAdd(State storage state, Add memory add) external {
        state.total += add.amount;
    }
}
```

<!-- TODO(kyle) mention how mutations with resolutions affect the mutation definition. -->

#### Signature

A signature authorizes a mutation on behalf of a user. The outer EVM
transaction is submitted by the scheduler, so `msg.sender` is always the
scheduler — it can't identify the user the way it does for direct contract
calls or for ERC-4337 `UserOperation`s. Each mutation in a batch carries its
own EIP-712 typed-data signature instead, and the contract verifies it
during `execute`.

**`Signature` struct.** The fields of `Signature` are not prescribed — they
are whatever the contract needs to authenticate the user and authorize the
mutation. The test fixtures and `apps/order-book` show three independent
shapes:

```sol
// test/contracts/src/Counter2.sol — public key looked up by account id
struct Signature { bytes32 accountId; bytes rawSignature; }

// test/contracts/src/Harness.sol — multi-key account, keyId selects the key
struct Signature { bytes32 account; uint64 keyId; uint8 keyType; bytes rawSignature; }

// apps/order-book/contracts/src/Exchange.sol — multi-key account, keyType resolved from the stored key list
struct Signature { bytes32 account; uint64 keyId; bytes rawSignature; }
```

Each is valid. The contract decides how the fields it declares are used:
looked up against state-stored accounts, embedded inline, or used to scope a
signature to a particular key, action, or window.

**Per-mutation typehash.** Each mutation has an EIP-712 typehash. The encoded
type string lists the mutation's arguments in declaration order:

```sol
bytes32 constant ADD_TYPEHASH = keccak256("add(uint256 amount,uint256 nonce)");
```

The primary type name (`add`), the parameter names, and their order must
agree with the mutation's Solidity struct. Standard EIP-712
typing rules apply (e.g. `uint256`, not `uint`).

**Verification helpers.** `ffca/Account.sol` exports the `KeyType` enum and
two helpers for verifying a raw signature against a digest:

```sol
import {KeyType, verifySignature, verifySignatureMemory} from "ffca/Account.sol";

verifySignature(KeyType keyType, bytes32 digest, bytes memory publicKey, bytes calldata signature) view;
verifySignatureMemory(KeyType keyType, bytes32 digest, bytes memory publicKey, bytes memory signature) view;
```

`KeyType` is `{ P256, WebAuthnP256, Secp256k1 }`. The two helpers differ only
in where `signature` is read from: the calldata variant is used on the hot
`execute` path; the memory variant is used on paths where the signature has
been decoded out of storage, such as force-inclusion queue entries. Both
revert with `InvalidSignature(KeyType)` on a failed check.

Byte layouts:

| `KeyType` | `publicKey` | raw `signature` |
| --- | --- | --- |
| `Secp256k1` | `abi.encode(address)` | `abi.encode(uint8 v, bytes32 r, bytes32 s)` |
| `P256` | 65-byte uncompressed (`0x04 \|\| X \|\| Y`) or `abi.encode(uint256 x, uint256 y)` | `abi.encode(uint256 r, uint256 s)` over `sha256(digest)` |
| `WebAuthnP256` | same as `P256` | `abi.encode(bytes authData, bytes clientDataJSON, uint256 challengeOffset, uint256 r, uint256 s)`; `clientDataJSON` must contain the base64url-encoded `digest` starting at `challengeOffset`, and the verified message is `sha256(authData \|\| sha256(clientDataJSON))` |

`Secp256k1` verification uses `ecrecover` and is `pure`. `P256` and
`WebAuthnP256` verification `staticcall` the precompile at address `0x100`;
deployments on chains without this precompile will revert from those paths.

#### Contract structure

The contract is a thin wrapper around the `State` struct, the framework-required immutables, and a constructor that wires them up. Everything else lives in the three external functions described below.

```sol
contract Token {
    State private state;

    address private immutable SCHEDULER;
    bytes32 private immutable DOMAIN_SEPARATOR;

    constructor(address _scheduler) {
        SCHEDULER = _scheduler;
        DOMAIN_SEPARATOR = keccak256(
            abi.encode(
                EIP712_DOMAIN_TYPEHASH,
                keccak256(bytes("Token")),
                keccak256(bytes("1")),
                block.chainid,
                address(this)
            )
        );
    }

    // execute, enqueue, forceExecute below
}
```

**`state`.** A single private storage variable wraps the State struct. The runtime reads its slots through revm via the layout emitted by `forge inspect storageLayout`, so Solidity visibility does not affect framework reads. Keeping `state` private signals that app-side reads should go through `ffca.state`, not through auto-generated public getters.

**`SCHEDULER`.** The framework's signing identity, set once in the constructor and checked by `execute`. Immutable — rotating the scheduler means redeploying.

**`DOMAIN_SEPARATOR`.** The EIP-712 domain separator from the Signature section, computed once in the constructor and cached as an immutable so per-mutation digest construction stays cheap. Apps that want replay protection across chain forks can additionally cache `INITIAL_CHAIN_ID` and recompute the separator from a view function when `block.chainid != INITIAL_CHAIN_ID` — see `apps/order-book`.

Force-inclusion-enabled contracts add one more storage variable, the queue array, described in the `enqueue` section.

#### `execute`

```sol
function execute(Bundle[] calldata batches, uint256[] calldata forceExecuteIndexes) external {
    if (msg.sender != SCHEDULER) revert Unauthorized();
    // ...
}
```

The single entry point through which the framework submits accepted mutations onchain. `execute` is gated on the `SCHEDULER` immutable set at construction (see Contract structure). Only the scheduler may invoke `execute` in normal operation.

`forceExecuteIndexes` carries the queue indexes of any force-included mutations the runtime is settling in the same call (see `enqueue`); apps without force-inclusion support may revert when this array is non-empty.

The function iterates each bundle, checks the three arrays are the same length, dispatches each `mutationData[i]` according to `mutations[i]`, verifies its signature, and applies the state change. Order within a bundle and across bundles is significant — it must match the order the runtime accepted server-side.

#### `enqueue`

```sol
function enqueue(uint8 mutation, bytes calldata mutationData, Signature calldata sig) external
```

The user-facing entry point for force inclusion. A user submits their mutation directly onchain, bypassing the scheduler. The contract stores the queued mutation and emits:

```sol
event ForceInclusionQueued(
    uint256 index,
    uint8 mutation,
    bytes mutationData,
    Signature sig,
    uint256 enqueuedBlock
);
```

The runtime's watch loop decodes `ForceInclusionQueued` to discover queued mutations, accepts them through revm, and carries their `index` into the next `execute` call's `forceExecuteIndexes`. The event signature is part of the conformance surface — the watch decoder reads exactly these fields in this order.

Apps that don't support force inclusion may revert from `enqueue` (and `forceExecute`) with a sentinel error such as `ForceInclusionUnsupported()`.

#### `forceExecute`

```sol
function forceExecute(uint256 index) external
```

The escape hatch for users when the scheduler is offline or censoring. After `FORCE_INCLUSION_DELAY` has elapsed since the mutation was enqueued, any caller may invoke `forceExecute(index)` to apply the queued mutation directly. The contract is responsible for enforcing the delay, clearing the queue entry on success, and reverting if the entry is missing or not yet eligible.

`forceExecute` shares the same mutation dispatch and signature verification as `execute`, but is not gated by `msg.sender == scheduler`.

#### Determinism

The runtime executes contract bytecode in revm against the last known block's environment. Opcodes whose values can't be reproduced offchain produce divergence between accepted and onchain state and must not affect mutation outcomes:

- `block.coinbase` (`COINBASE`) — the miner of the block containing the transaction is not known until inclusion.
- `block.difficulty` / `block.prevrandao` (`PREVRANDAO`) — post-merge randomness is set by the block proposer.
- `blockhash(n)` (`BLOCKHASH`) for blocks the server hasn't seen.
- `blobhash(i)` (`BLOBHASH`) and `block.blobbasefee` (`BLOBBASEFEE`) — blob context belongs to the submitting transaction, not the mutation.
- `gasleft()` (`GAS`) — gas accounting in revm does not match the live EVM, so any branch on remaining gas can diverge.

`block.number` and `block.timestamp` are an open question: today the runtime executes against the last known block's values, but the precise semantics (latest+1 vs. wall-clock vs. scheduler-controlled) are not yet settled. Contracts that read either should treat them as approximate.

`tx.origin` and `msg.sender` are stable. Both resolve to the scheduler in normal `execute` flow, and to the caller in `forceExecute`. They are safe to branch on.

### `createFFCA()`

### `ffca.domain`

### `ffca.execute()`

### `ffca.state`

### `ffca.schema`

### `ffca.on()`

### `verifySignature()`
