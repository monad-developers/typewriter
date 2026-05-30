# FFCA

Full stack framework for building crypto apps.

- **Custom sequencing**. Applications define their transaction ordering (fifo, batch, or any rule it chooses).
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

Mutations are authorized with signatures, not transactions. Each mutation carries an EIP-712 typed-data signature, and the contract verifies it.

FFCA supports three signature algorithms:

- P-256
- WebAuthn-P256
- secp256k1

It exports the primitives that go with them — the `KeyType` enum, a `verifySignature` helper, and the EIP-712 domain typehash. The `Signature` struct itself is app-defined; the contract decides what fields it needs to authenticate the user and authorize the mutation. See [Contract requirements > Signature](#signature) for more information.

Accounts are entirely app-defined. The account registry shape, key lookup, nonce policy, expiry/deadline checks, bootstrap mutations, and permissions all live in the app's contract and state. FFCA does not impose an `Account` struct or any specific authorization rule.

### Server runtime

Mutations are submitted to an application server, not directly to the chain. Users sign mutations, not transactions; in normal operation the server is the party that submits transactions to the chain. Each mutation is executed locally in an embedded EVM (revm) against the server's copy of contract state, and once the server knows the mutation will succeed onchain it responds `accepted` — usually within milliseconds, before a block is produced. The lifecycle from there is described in [Mutations](#mutations).

`createFFCA` instantiates the runtime: it connects to the chain and database, hydrates local state, and starts submitting accepted mutations onchain.

`FFCAConfig` requires `address`, `domain`, `storageLayout`, `account`, `chainId`, `rpcUrl`, `database`, `mutations`, and `signature`. Optional runtime controls are `blockPollingIntervalMs`, `confirmations`, `onFatalError`, and `sequencing`.

```ts
import { createFFCA } from "ffca";
import { parseAbiParameters } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const ffca = await createFFCA({
  address, // the deployed FFCA contract
  abi,
  storageLayout, // from `forge inspect <Contract> storageLayout`
  domain: { name: "Token", version: "1" },
  account: privateKeyToAccount(schedulerPrivateKey), // the scheduler
  chainId,
  rpcUrl,
  database: { url: databaseUrl },
  mutations, // per-mutation tag, params, and optional resolution
  signature: { params: parseAbiParameters("bytes signature") },
  confirmations: {
    safeBlockDepth: 1,
    finalizedBlockDepth: 5,
  },
  blockPollingIntervalMs: 200,
  sequencing: {
    order: "fifo",
    submitIntervalMs: 400,
  },
});

// submit a signed mutation; resolves once accepted
const accepted = await ffca.execute({ name: "Transfer", args, signature });
```

Accepted mutations are written onchain in groups on a fixed interval (see [Sequencing](#sequencing)), not one transaction at a time.

> Onchain submission is gated to a single scheduler address that the server controls (see [Contract structure](#contract-structure)). Because no one else can submit transactions, the server can simulate a mutation locally and trust the result will hold onchain — which is what lets it respond `accepted` before a block is produced.

#### Sequencing

Sequencing controls the order mutations are accepted by the server and included onchain. FFCA ships two sequencing modes: FIFO and batch. FIFO is the default when `sequencing.order` is omitted.

A mutation is `accepted` once the server has assigned it a position in the local execution order and run it against local state (see [Mutations](#mutations)). When a mutation is submitted with `ffca.execute()`, FFCA places it in an order relative to other mutations submitted around the same time. Mutations are written onchain in groups on a fixed interval, not one at a time.

##### FIFO

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

##### Batch

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

If the server is completely offline, the user may call `forceExecute()` on their queued mutation after the `FORCE_INCLUSION_DELAY`.

### Offchain/onchain divergence

Mutations are executed and accepted on the server before they are executed onchain. Onchain divergence happens when the server's local execution environment accepts a mutation, but the same mutation behaves differently (and reverts) when executed onchain.

This can happen when the execution depends on EVM environment opcodes whose values differ from the values used in the mined transaction, or on state the server cannot reproduce locally, such as another contract's storage (see [Determinism](#determinism)).

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
- **`struct [Mutation]` definition**. The mutation's arguments. The app's `dispatch` function ABI-decodes the mutation's `mutationData` into this struct, and the same fields serve as the EIP-712 message body. Field names and order must match the `FFCAMutationConfig.params` registered with the runtime.
- **`execute[Mutation]` function**. Applies the mutation to the state. Called by `dispatch` after the signature has verified — no auth checks here, just the state transition.
- **`hash[Mutation]` function**. Returns the EIP-712 struct hash of the mutation: `keccak256(abi.encode([MUTATION]_TYPEHASH, field1, field2, ...))`. The `[MUTATION]_TYPEHASH` it hashes against is the canonical EIP-712 type string — `keccak256("name(type1 field1,type2 field2,...)")` — whose primary type name, parameter names, and declaration order must match the mutation's struct (standard EIP-712 typing rules apply, e.g. `uint256`, not `uint`). `dispatch` combines this struct hash with the `DOMAIN_SEPARATOR` to form the digest passed to `verify[Mutation]Signature`.
- **`verify[Mutation]Signature` function**. Authorizes the mutation. Resolves the signer from the `Signature` fields, enforces any replay protection (nonce, deadline, scope), and calls `verifySignature` from `ffca/FFCA.sol` to check the raw signature against the digest (see [Signature](#signature)).

```sol
library AddMutation {
    struct Add {
        uint256 amount;
        uint256 nonce;
    }

    bytes32 constant ADD_TYPEHASH = keccak256("add(uint256 amount,uint256 nonce)");

    function hashAdd(Add memory add) internal pure returns (bytes32) {
        return keccak256(abi.encode(ADD_TYPEHASH, add.amount, add.nonce));
    }

    function verifyAddSignature(State storage state, Add memory add, Signature memory signature, bytes32 digest) external {
        Account storage account = state.accounts[signature.accountId];
        if (account.nonce != add.nonce) revert InvalidNonce();
        verifySignature(KeyType(account.keyType), digest, account.publicKey, signature.rawSignature);
        account.nonce++;
    }

    function executeAdd(State storage state, Add memory add) external {
        state.total += add.amount;
    }
}
```

<!-- TODO(kyle) mention how mutations with resolutions affect the mutation definition. -->

#### Signature

A signature authorizes a mutation on behalf of a user. The outer EVM transaction is submitted by the server, so `msg.sender` can't be used to identify a user. Each mutation in a batch carries an EIP-712 typed-data signature that the contract verifies.

**`Signature` struct.** The fields of `Signature` are not prescribed — they
are whatever the contract needs to authenticate the user and authorize the
mutation.

```sol
struct Signature { 
    bytes32 accountId; 
    bytes rawSignature;
}
```

**`verify[Mutation]Signature`.** Every signed mutation implements its own
verifier — see the [Mutations](#mutations) example.

```sol
function verify[Mutation]Signature(
    State storage state,
    [Mutation] memory args,
    Signature memory signature,
    bytes32 digest
) external;
```

The verifier is responsible for resolving the signer from the `Signature`
fields (e.g. looking up an account, selecting a key), enforcing replay
protection (nonce, deadline, scope), and calling one of the `verifySignature`
helpers below to verify the raw signature against the digest.

Per-mutation verification gives each mutation full control over its
authorization rules, including whether a signature is required at all —
bootstrap mutations may not need one.

**Verification helpers.** `ffca/FFCA.sol` exports the `KeyType` enum and
a `verifySignature` helper for verifying a raw signature:

```sol
import {KeyType, verifySignature} from "ffca/FFCA.sol";

verifySignature(KeyType keyType, bytes32 digest, bytes memory publicKey, bytes memory signature) view;
```

`KeyType` is `{ P256, WebAuthnP256, Secp256k1 }`. `verifySignature` will revert with `InvalidSignature(KeyType)` on a failed check.

Byte layouts:

| `KeyType` | `publicKey` | raw `signature` |
| --- | --- | --- |
| `Secp256k1` | `abi.encode(address)` | `abi.encode(uint8 v, bytes32 r, bytes32 s)` |
| `P256` | 65-byte uncompressed (`0x04 \|\| X \|\| Y`) or `abi.encode(uint256 x, uint256 y)` | `abi.encode(uint256 r, uint256 s)` over `sha256(digest)` |
| `WebAuthnP256` | same as `P256` | `abi.encode(bytes authData, bytes clientDataJSON, uint256 challengeOffset, uint256 r, uint256 s)`; `clientDataJSON` must contain the base64url-encoded `digest` starting at `challengeOffset`, and the verified message is `sha256(authData \|\| sha256(clientDataJSON))` |

`Secp256k1` verification uses `ecrecover` and is `pure`. `P256` and
`WebAuthnP256` verification `staticcall` the precompile at address `0x100`;
deployments on chains without this precompile will revert from those paths.

The EIP-712 digest each verifier checks is built from the mutation's struct
hash (see [`hash[Mutation]`](#mutations)) and the contract's `DOMAIN_SEPARATOR`.

#### Contract structure

The contract inherits from `ffca/FFCA.sol`, which supplies the `SCHEDULER`, `DOMAIN_SEPARATOR`, and `FORCE_INCLUSION_DELAY` immutables, the `Batch` and `QueuedMutation` structs, the force-inclusion queue, the `execute`, `enqueue`, and `forceExecute` entry points, and the `ForceInclusionQueued` event. The app contract is a thin wrapper around its own `State` and a `Mutation` enum (mapping `uint8` tags to mutation names), a constructor that assigns the inherited immutables, and a single `dispatch` function (see [`dispatch`](#dispatch)). `FFCA` uses the app's `dispatch` to build the external-facing `execute`, `enqueue`, and `forceExecute` methods, routing every mutation — whether batched by the scheduler or force-included — through it.

```sol
import {EIP712_DOMAIN_TYPEHASH, FFCA} from "ffca/FFCA.sol";

contract Token is FFCA {
    State private state;

    enum Mutation {
        NewAccount,
        Add
    }

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
        FORCE_INCLUSION_DELAY = 658;
    }

    // dispatch below
}
```

**`state`.** A single non-public storage variable wraps the State struct. Underlying storage slots are read directly so Solidity visibility does not affect framework reads.

**`Mutation` enum.** Designates the valid mutations for the contract.

**`SCHEDULER`.** The privileged address for submitting mutations. Declared in `FFCA` as `address internal immutable` — the inheriting contract must assign it in the constructor.

**`DOMAIN_SEPARATOR`.** The EIP-712 domain separator from the [Signature](#signature) section. Declared in `FFCA` as `bytes32 internal immutable` — the inheriting contract must assign it in the constructor.

**`FORCE_INCLUSION_DELAY`.** The number of blocks that must elapse after a mutation is enqueued before any caller may `forceExecute` it. Declared in `FFCA` as `uint256 internal immutable` — `FFCA` does not impose a value, so the inheriting contract must assign it in the constructor. `Counter.sol` uses `658` blocks (≈4.4 minutes at 0.4 s/block).

**Inherited external ABI.** `execute`, `enqueue`, and `forceExecute` are implemented by `FFCA` (no app code), but they define the contract's external surface that the runtime and clients depend on:

```sol
// Scheduler-gated settlement. `forceExecuteIndexes` settles queued
// force-included mutations alongside the batches.
function execute(Batch[] calldata batches, uint256[] calldata forceExecuteIndexes) external;

// User force-inclusion entry point. Pushes a `QueuedMutation` and emits
// `ForceInclusionQueued`.
function enqueue(uint8 mutation, bytes calldata mutationData, bytes calldata signatureData) external returns (uint256);

// Un-gated escape hatch, callable by anyone once `FORCE_INCLUSION_DELAY` blocks
// have elapsed since the entry was enqueued.
function forceExecute(uint256 index) external;
```

`enqueue` emits `ForceInclusionQueued`, which clients and watchers decode to discover queued mutations:

```sol
event ForceInclusionQueued(
    uint256 index,
    uint8 mutation,
    bytes mutationData,
    bytes signatureData,
    uint256 enqueuedBlock
);
```

#### `dispatch`

```sol
function dispatch(uint8 mutation, bytes memory mutationData, bytes memory signatureData) internal override;
```

The single function an app must implement. `FFCA` calls `dispatch` once per mutation — for every mutation in every `Batch` passed to `execute`, for every queue entry settled through `execute`'s `forceExecuteIndexes`, and for every public `forceExecute`. The app never iterates batches or touches the queue itself; it only describes how to turn one `(mutation, mutationData, signatureData)` tuple into a state transition.

For each mutation, branch on the `uint8` tag (matched against the `Mutation` enum), decode `mutationData` and `signatureData` into the mutation's structured types, compute the EIP-712 digest, call `verify[Mutation]Signature`, then call `execute[Mutation]` (see [Mutations](#mutations)). Revert with `UnknownMutation(mutation)` on an unrecognized tag.

```sol
function dispatch(uint8 mutation, bytes memory mutationData, bytes memory signatureData) internal override {
    if (Mutation(mutation) == Mutation.NewAccount) {
        // NewAccount requires no signature verification
        NewAccountMutation.NewAccount memory newAccount =
            abi.decode(mutationData, (NewAccountMutation.NewAccount));
        NewAccountMutation.executeNewAccount(state, newAccount);
    } else if (Mutation(mutation) == Mutation.Add) {
        AddMutation.Add memory add = abi.decode(mutationData, (AddMutation.Add));
        Signature memory signature = abi.decode(signatureData, (Signature));

        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR, AddMutation.hashAdd(add)));

        AddMutation.verifyAddSignature(state, add, signature, digest);
        AddMutation.executeAdd(state, add);
    } else {
        revert UnknownMutation(mutation);
    }
}
```

`dispatch` sees one mutation at a time and is intentionally order-agnostic. `FFCA` is responsible for invoking it in the order mutations were accepted server-side: across batches in submission order, and within a batch in array order.

#### Determinism

Opcodes whose values can't be reproduced offchain produce divergence between offchain and onchain state are incompatible with FFCA:

- `block.coinbase` (`COINBASE`) — the miner of the block containing the transaction is not known until inclusion.
- `block.difficulty` / `block.prevrandao` (`PREVRANDAO`) — post-merge randomness is set by the block proposer.
- `blockhash(n)` (`BLOCKHASH`) for blocks the server hasn't seen.
- `blobhash(i)` (`BLOBHASH`) and `block.blobbasefee` (`BLOBBASEFEE`) — blob context belongs to the submitting transaction, not the mutation.
- `gasleft()` (`GAS`) — gas accounting in revm does not match the live EVM, so any branch on remaining gas can diverge.

`block.number` and `block.timestamp` are approximations — not guaranteed to match the block a mutation settles in. The server executes accepted mutations against the last known block's values, so what a mutation sees lags the block of inclusion by at least one. They're fine for coarse-grained checks (expiries, epoch windows) but unsafe for tight windows, sub-block timing, or logic that branches on the exact block of inclusion.

`tx.origin` and `msg.sender` are stable. Both resolve to the scheduler in normal `execute` flow, and to the caller in `forceExecute`.

Calls to external contracts are not allowed. The server executes mutations against its own local state, which only covers the FFCA contract — it has no view of other contracts' storage, so any external call (or the state it depends on) cannot be reproduced offchain and will diverge.

### `createFFCA()`

### `ffca.domain`

### `ffca.execute()`

### `ffca.state`

### `ffca.schema`

### `ffca.on()`

### `verifySignature()`
