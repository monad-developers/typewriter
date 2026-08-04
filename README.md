# Typewriter

Typewriter is a framework for crypto apps that need custom transaction sequencing, fast confirmations, and built-in gas sponsorship.

You write Solidity state and mutations. Then, Typewriter runs a server that orders user-signed mutations, executes them locally for acceptance in roughly 50ms, and submits them onchain.

The server is trusted for day-to-day ordering and availability, but it does not control user funds. Users can bypass the server and submit valid mutations directly onchain through force inclusion.

- **Custom sequencing**. Applications define their transaction ordering (fifo or batch).
- **Fast confirmations**. Applications can accept mutations in roughly 50ms, before transactions finalize onchain.
- **Gas sponsorship**. Users sign application mutations while the server pays for settlement transactions.
- **Modern signature primitives**. EIP-712 plus native P-256, WebAuthn-P256, and secp256k1 verification; apps define their own account policy.
- **Direct control**. No external relayers, sequencers, or builder auctions between users and the application. The application has end-to-end control over what users experience.
- **Local first**. Build rapidly with a powerful local development loop.

> [!WARNING]
> **This project is under active development. Not ready for production use.**
> It is provided for educational purposes and has not been audited. Do not use it in connection with real funds on mainnet without an independent audit.

## Concepts

### State

Application state lives onchain, where the Solidity state definition serves as the ground truth.

```solidity
struct State {
    uint256 totalSupply;
    mapping(bytes32 => Account) accounts;
}
```

### Mutations

Mutations are app-defined state transitions requested by a user and executed onchain. Updates to application state are done with mutations.

```solidity
struct Transfer {
    bytes32 from;
    bytes32 to;
    uint256 amount;
    uint256 nonce;
}

function executeTransfer(State storage state, Transfer memory transfer) {
    state.accounts[transfer.from].balance -= transfer.amount;
    unchecked {
        state.accounts[transfer.to].balance += transfer.amount;
    }
}
```

### Accounts and Signatures

Mutations are authorized with an EIP-712 typed-data signature, and the contract verifies it.

Typewriter supports three signature algorithms:

- P-256
- WebAuthn-P256
- secp256k1

It exports the primitives that go with them — the `KeyType` enum, a `verifySignature` helper, and the EIP-712 domain typehash. The `Signature` struct itself is app-defined; the contract decides what fields it needs to authenticate the user and authorize the mutation.

Accounts are entirely app-defined. The account registry shape, key lookup, nonce policy, expiry/deadline checks, bootstrap mutations, and permissions all live in the app's contract and state. Typewriter does not impose an `Account` struct or any specific authorization rule.

```solidity
import {KeyType, verifySignature} from "typewriter/Typewriter.sol";

// App-defined — Typewriter imposes no Account or Signature shape.
struct Account {
    KeyType keyType;
    bytes publicKey;
    uint256 nonce;
}

struct Signature {
    bytes32 accountId;
    bytes rawSignature;
}

// The Typewriter primitive checks a raw signature against a digest. A mutation's
// verifier calls it after resolving the account and applying replay protection.
verifySignature(KeyType(account.keyType), digest, account.publicKey, signature.rawSignature);
```

See [Contract requirements > Signature](#signature) for the full verifier and signature byte layouts.

### Server runtime

A mutation is the framework equivalent of a transaction, but unlike a transaction it is not submitted directly onchain. Instead mutations are submitted to an application server where they can be reordered and accepted quickly, then eventually made durable with onchain execution. Users sign mutations, not transactions; in normal operation the server is the party that submits transactions to the chain. Each mutation is executed locally in an embedded EVM (revm) against the server's copy of contract state, and once the server knows the mutation will succeed onchain it responds `accepted` — usually within milliseconds, before a block is produced.

The lifecycle of a mutation is as follows:
- **received**. The server has received the mutation.
- **accepted**. The server has ordered and executed the mutation locally.
- **included**. The server submitted the mutation onchain and it has been included in a block.
- **safe**. The block that contains the mutation has been marked "safe" by consensus. (See JSON-RPC "safe" tag).
- **finalized**. The block that contains the mutation has been marked "finalized" by consensus. (See JSON-RPC "finalized" tag).

`createTypewriter` starts the runtime and returns a handle for submitting mutations, reading state, and subscribing to events.

`createTypewriter` takes a Solidity entrypoint and runtime config. `TypewriterConfig` requires `address`, `account`, `chainId`, `rpcUrl`, and `database`. Contract metadata (`storageLayout`, mutations, and signature params) is derived from the Solidity entrypoint. Optional runtime controls are `blockPollingIntervalMs`, `confirmations`, `onFatalError`, and `sequencing`.

```ts
import { createTypewriter } from "typewriter";
import { privateKeyToAccount } from "viem/accounts";
import Token from "../contracts/src/Token.sol";

const typewriter = await createTypewriter(Token, {
  address, // the deployed Typewriter contract
  account: privateKeyToAccount(privateKey), // the transaction submitter
  chainId,
  rpcUrl,
  database: { url: databaseUrl },
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

// ... setup web server

// submit a signed mutation; resolves once accepted
const accepted = await typewriter.execute({ name: "transfer", params, signature });
```

> Onchain submission is gated to a single scheduler address that the server controls (see [Contract structure](#contract-structure)). Because no one else can submit transactions, the server can simulate a mutation locally and trust the result will hold onchain — which is what lets it respond `accepted` before a block is produced.

#### Sequencing

Sequencing controls the order mutations are accepted by the server and included onchain. Typewriter ships two sequencing modes: FIFO and batch. FIFO is the default when `sequencing.order` is omitted.

##### FIFO

```ts
import { createTypewriter } from "typewriter";

const app = await createTypewriter(Token, {
  // ... more config
  sequencing: {
    order: "fifo",
    submitIntervalMs: 400,
  },
});
```

Each call to `typewriter.execute()` immediately executes the mutation against local state and returns the accepted mutation, or throws an error if the mutation is rejected. Every `submitIntervalMs`, all accepted mutations are submitted with a single onchain transaction.

Onchain inclusion order matches the order mutations were executed with `typewriter.execute()`.

##### Batch

```ts
import { createTypewriter } from "typewriter";

const app = await createTypewriter(Token, {
  // ... more config
  sequencing: {
    order: "batch",
    batchIntervalMs: 50,
    submitIntervalMs: 400,
    batchOrder: ["cancelOrder", "limitOrder", "marketOrder"],
  }
});
```

Each call to `typewriter.execute()` enqueues the mutation and returns the accepted mutation once the next batch is processed, or throws an error if the mutation is rejected. Every `batchIntervalMs`, all enqueued mutations are gathered into a batch, ordered according to `batchOrder`, and accepted or rejected. Every `submitIntervalMs`, all batches are submitted with a single onchain transaction.

Within a batch, mutations execute in `batchOrder`; across batches, batches are submitted in the order they were accepted.

## Examples

- [`token`](https://github.com/monad-exp/order-book/tree/main/apps/token) is a minimal token application that demonstrates FIFO mutation sequencing, account-owned transfers, and the smallest practical Typewriter app shape.
- [`order-book`](https://github.com/monad-exp/order-book/tree/main/apps/order-book) is a full order-book application with custom sequencing, WebAuthn account bootstrap, session keys, deposits, withdrawals, and onchain settlement.
- [`pixel-war`](https://github.com/monad-exp/order-book/tree/main/apps/pixel-war) is a team pixel-canvas game whose batch order is its rulebook — within a batch every `Shield` resolves before every `Paint` and every `Paint` before every `Bomb` — plus passkey sign-up, gas-sponsored play, and a force-inclusion escape hatch.

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

When a server-submitted transaction reverts, "accepted" mutations may move backwards in the mutation lifecycle (to "received"). They are re-processed against the current canonical chain state and re-emitted with their updated lifecycle status. From the user's perspective, this is no different than a chain reorganization.

The server execution environment uses values from the last known block for EVM environment opcodes. Certain EVM environment opcodes, such as `COINBASE` or `PREVRANDAO`, can make divergence more likely or even guaranteed. For a full list of unsupported opcodes, see [contract requirements](#contract-requirements).

> Coming soon: If onchain execution results in a different state transition than the server accepted, the transaction will revert instead of settling a mismatched result.

### Crash recovery

The server can be restarted at any time without losing accepted state. Every mutation and raw slot write is persisted to Postgres as it happens. On startup, the runtime rehydrates its local execution environment from the persisted slot writes.

Mutations that were accepted before the crash but had not yet reached `finalized` are reconciled with the underlying chain on restart.

## API reference

### Contract requirements

In order to be Typewriter-compliant, a smart contract must be written with Solidity and implement certain data structures and methods.

#### State

All application state is contained in a single `struct State`.

```solidity
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

> All Solidity data types are supported. Mapping and dynamic keys touched during accepted execution are recovered from the local EVM trace and persisted for read models when their storage slot preimages are available.

#### Mutations

Each mutation is a Solidity library with:
- **`struct [Mutation]` definition**. The mutation's arguments. The app's `dispatch` function ABI-decodes the mutation's `mutationData` into this struct, and the same fields serve as the EIP-712 message body. Field names and order define the mutation params the runtime extracts from Solidity.
- **`execute[Mutation]` function**. Applies the mutation to the state. Called by `dispatch` after the signature has verified — no auth checks here, just the state transition.
- **`hash[Mutation]` function**. Returns the EIP-712 struct hash of the mutation: `keccak256(abi.encode([MUTATION]_TYPEHASH, field1, field2, ...))`. The `[MUTATION]_TYPEHASH` it hashes against is the canonical EIP-712 type string — `keccak256("name(type1 field1,type2 field2,...)")` — whose primary type name must match the Solidity `Mutation` enum member with the first letter lowercased (the client signs this as the `primaryType`), and whose parameter names and declaration order must match the decoded mutation struct (standard EIP-712 typing rules apply, e.g. `uint256`, not `uint`). The type name is independent of the Solidity struct name — e.g. `Mutation.Add` with an `Add` struct uses `keccak256("add(uint256 amount,uint256 nonce)")`. `dispatch` combines this struct hash with the `DOMAIN_SEPARATOR` to form the digest passed to `verify[Mutation]Signature`.
- **`verify[Mutation]Signature` function**. Authorizes the mutation. Resolves the signer from the `Signature` fields, enforces any replay protection (nonce, deadline, scope), and calls `verifySignature` from `typewriter/Typewriter.sol` to check the raw signature against the digest (see [Signature](#signature)).

```solidity
library AddMutation {
    struct Add {
        uint256 amount;
        uint256 nonce;
    }

    bytes32 constant ADD_TYPEHASH = keccak256("add(uint256 amount,uint256 nonce)");

    function hashAdd(Add memory add) internal pure returns (bytes32) {
        return keccak256(abi.encode(ADD_TYPEHASH, add.amount, add.nonce));
    }

    function verifyAddSignature(State storage state, Add memory add, Signature memory signature, bytes32 digest) internal {
        Account storage account = state.accounts[signature.accountId];
        if (account.nonce != add.nonce) revert InvalidNonce(account.nonce, add.nonce);
        verifySignature(KeyType(account.keyType), digest, account.publicKey, signature.rawSignature);
        account.nonce++;
    }

    function executeAdd(State storage state, Add memory add) internal {
        state.total += add.amount;
    }
}
```

#### Signature

A signature authorizes a mutation on behalf of a user. The outer EVM transaction is submitted by the server, so `msg.sender` can't be used to identify a user. Each mutation in a batch carries an EIP-712 typed-data signature that the contract verifies.

**`Signature` struct.** The fields of `Signature` are not prescribed — they
are whatever the contract needs to authenticate the user and authorize the
mutation.

```solidity
struct Signature { 
    bytes32 accountId; 
    bytes rawSignature;
}
```

**`verify[Mutation]Signature`.** Every signed mutation implements its own
verifier — see the [Mutations](#mutations) example.

```solidity
function verify[Mutation]Signature(
    State storage state,
    [Mutation] memory [mutation],
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

**Verification helpers.** `typewriter/Typewriter.sol` exports the `KeyType` enum and
a `verifySignature` helper for verifying a raw signature:

```solidity
import {KeyType, verifySignature} from "typewriter/Typewriter.sol";

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

The contract inherits from `typewriter/Typewriter.sol`, which supplies the `SCHEDULER`, `DOMAIN_SEPARATOR`, and `FORCE_INCLUSION_DELAY` immutables, the `Batch` and `QueuedMutation` structs, the force-inclusion queue, the `execute`, `enqueue`, and `forceExecute` entry points, and the `ForceInclusionQueued` event. The app contract is a thin wrapper around its own `State` and a `Mutation` enum (mapping `uint8` tags to mutation names), a constructor that assigns the inherited immutables, and a single `dispatch` function (see [`dispatch`](#dispatch)). `Typewriter` uses the app's `dispatch` to build the external-facing `execute`, `enqueue`, and `forceExecute` methods, routing every mutation — whether batched by the scheduler or force-included — through it.

```solidity
import {EIP712_DOMAIN_TYPEHASH, Typewriter} from "typewriter/Typewriter.sol";

contract Token is Typewriter {
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

**`SCHEDULER`.** The privileged address for submitting mutations. Declared in `Typewriter` as `address internal immutable` — the inheriting contract must assign it in the constructor.

**`DOMAIN_SEPARATOR`.** The EIP-712 domain separator from the [Signature](#signature) section. Declared in `Typewriter` as `bytes32 internal immutable` — the inheriting contract must assign it in the constructor.

**`FORCE_INCLUSION_DELAY`.** The number of blocks that must elapse after a mutation is enqueued before any caller may `forceExecute` it. Declared in `Typewriter` as `uint256 internal immutable` — `Typewriter` does not impose a value, so the inheriting contract must assign it in the constructor. All examples in this repo use `658` blocks (≈4.4 minutes at 0.4 s/block).

**Inherited external ABI.** `execute`, `enqueue`, and `forceExecute` are implemented by `Typewriter` (no app code), but they define the contract's external surface that the runtime and clients depend on:

```solidity
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

```solidity
event ForceInclusionQueued(
    uint256 index,
    uint8 mutation,
    bytes mutationData,
    bytes signatureData,
    uint256 enqueuedBlock
);
```

#### `dispatch`

```solidity
function dispatch(uint8 mutation, bytes memory mutationData, bytes memory signatureData) internal override;
```

The single function an app must implement. `Typewriter` calls `dispatch` once per mutation — for every mutation in every `Batch` passed to `execute`, for every queue entry settled through `execute`'s `forceExecuteIndexes`, and for every public `forceExecute`. The app never iterates batches or touches the queue itself; it only describes how to turn one `(mutation, mutationData, signatureData)` tuple into a state transition.

For each mutation, branch on the `uint8` tag (matched against the `Mutation` enum), decode `mutationData` and `signatureData` into the mutation's structured types, compute the EIP-712 digest, call `verify[Mutation]Signature`, then call `execute[Mutation]` (see [Mutations](#mutations)). Revert with `UnknownMutation(mutation)` on an unrecognized tag.

```solidity
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

`dispatch` sees one mutation at a time and is intentionally order-agnostic. `Typewriter` is responsible for invoking it in the order mutations were accepted server-side: across batches in submission order, and within a batch in array order.

#### Determinism

Opcodes whose values can't be reproduced offchain produce divergence between offchain and onchain state, so they are incompatible with Typewriter:

- `block.coinbase` (`COINBASE`) — the miner of the block containing the transaction is not known until inclusion.
- `block.difficulty` / `block.prevrandao` (`PREVRANDAO`) — post-merge randomness is set by the block proposer.
- `blockhash(n)` (`BLOCKHASH`) for blocks the server hasn't seen.
- `blobhash(i)` (`BLOBHASH`) and `block.blobbasefee` (`BLOBBASEFEE`) — blob context belongs to the submitting transaction, not the mutation.
- `gasleft()` (`GAS`) — gas accounting in revm does not match the live EVM, so any branch on remaining gas can diverge.

`block.number` and `block.timestamp` are approximations — not guaranteed to match the block a mutation settles in. The server executes accepted mutations against the last known block's values, so what a mutation sees lags the block of inclusion by at least one. They're fine for coarse-grained checks (expiries, epoch windows) but unsafe for tight windows, sub-block timing, or logic that branches on the exact block of inclusion.

`tx.origin` and `msg.sender` are stable. Both resolve to the scheduler in normal `execute` flow, and to the caller in `forceExecute`.

Calls to external contracts are not allowed. The server executes mutations against its own local state, which only covers the Typewriter contract — it has no view of other contracts' storage, so any external call (or the state it depends on) cannot be reproduced offchain and will diverge.

### Server runtime

The JavaScript surface exported from `typewriter`: the `createTypewriter` entry point and the `Typewriter` handle it returns (`state`, `schema`, `domain`, `execute`, `on`, `close`).

#### `createTypewriter()`

```ts
function createTypewriter(config: TypewriterConfig): Promise<Typewriter>;
```

Starts the runtime and resolves to the `Typewriter` handle (see the [Server runtime](#server-runtime) example for a full call). On startup it connects to the chain and database, runs migrations, and hydrates local revm state from persisted slot writes; from there it accepts mutations and submits them onchain.

**`TypewriterConfig`.** Required fields:

- `address` — the deployed Typewriter contract.
- `account` — the scheduler `PrivateKeyAccount`; signs and submits the onchain `execute` transactions.
- `chainId` — number.
- `rpcUrl` — `string | string[]`.
- `database` — `{ url, maxConnections? }` (Postgres).

Optional runtime controls: `blockPollingIntervalMs` (default `200`), `confirmations` (`{ safeBlockDepth?, finalizedBlockDepth? }`, defaults `1` / `5`), `onFatalError` (`(error) => void`; without it a fatal runtime error is rethrown), and `sequencing` (see [Sequencing](#sequencing); defaults to FIFO).

The Solidity entrypoint must be importable by Bun. At startup, typewriter runs `forge build`, reads the compiled ABI/storage layout/AST, and derives mutation tags, params, signature params, and typed storage from the contract.

#### `typewriter.domain`

```ts
typewriter.domain: TypedData.Domain; // { name, version, chainId, verifyingContract }
```

The resolved EIP-712 domain, derived from Typewriter's fixed domain plus `chainId` and the contract `address`. Clients build the typed-data payload they sign from this domain and the mutation's `params`; the contract checks the resulting signature in `verify[Mutation]Signature`. Apps typically expose it for the frontend to sign against:

```ts
"/api/domain": () => jsonResponse(typewriter.domain),
```

#### `typewriter.execute()`

```ts
typewriter.execute(input: { name, params, signature }): Promise<{ id }>;
```

Submits a signed mutation. `name` is a Solidity `Mutation` enum member with the first letter lowercased, `params` matches the mutation struct decoded in `dispatch`, and `signature` matches the contract's `Signature` struct. Resolves once the mutation is `accepted` (ordered and executed against local state); rejects if the mutation reverts. The result carries the mutation `id`. Acceptance timing follows [Sequencing](#sequencing) — immediate for FIFO, at the next batch interval for batch.

```ts
const accepted = await typewriter.execute({ name: "transfer", params, signature });
// accepted.id
```

#### `typewriter.state`

```ts
typewriter.state: StorageProxy<storageLayout>;
```

`typewriter.state` is how an app reads the contract's onchain state. It replaces the public getters and `view` functions you would normally read over `eth_call`: state is read directly from storage slots (typed by `storageLayout`), so the contract needs no public accessors and Solidity visibility doesn't matter. Reads resolve against the runtime's local, revm-backed mirror of that storage rather than issuing an `eth_call` per read; field accesses return promises, and mappings are indexed by key.

```ts
const account = typewriter.state.accounts[address];
const balance = await account.balance; // bigint
const nonce = await account.nonce;
```

`typewriter.state` reflects locally accepted state, which can be ahead of what is `included` or `finalized` onchain.

#### `typewriter.schema`

```ts
typewriter.schema: TypewriterSchema;
```

The [Drizzle](https://orm.drizzle.team) tables the runtime generates and migrates for this deployment. typewriter owns these tables; apps read from them to build read models (decoded mutation history, per-account views, and so on).

One table per Solidity `Mutation` enum member, named `<name>_mutations` with the runtime mutation name lowercased — `Mutation.Transfer` becomes `typewriter.schema.transfer_mutations`, `Mutation.MarketOrder` becomes `marketorder_mutations`. A row is written when a mutation is `accepted` and updated as it advances; `received` and `rejected` mutations are not persisted here.

Every mutation table starts with the same **lifecycle columns**:

| Column | Type | Notes |
| --- | --- | --- |
| `id` | `integer`, primary key | mutation id; matches the `typewriter.execute()` result and event `id` |
| `status` | `mutation_status` enum | one of `accepted`, `included`, `safe`, `finalized` |
| `executionIndex` | `numeric(78,0)` bigint | onchain execution index; set once included |
| `blockNumber` | `numeric(78,0)` bigint | inclusion block; null until included |
| `blockHash` | `char(66)` (hex) | null until included |
| `blockTimestamp` | `numeric(78,0)` bigint | null until included |
| `transactionHash` | `char(66)` (hex) | the settlement transaction; null until included |
| `acceptedAt` | `timestamp`, defaults to now | |
| `includedAt` | `timestamp` | null until included |
| `safeAt` | `timestamp` | null until safe |
| `finalizedAt` | `timestamp` | null until finalized |

Then two groups of payload columns:

- **Param columns** — one per ABI parameter in the mutation struct decoded by `dispatch`, named after the parameter (an unnamed parameter becomes `arg<index>`).
- **Signature columns** — one per ABI parameter in the contract's `Signature` struct, each prefixed `signature_`.

Payload columns are typed from their ABI type:

| ABI type | Postgres column |
| --- | --- |
| `bool` | `boolean` |
| `address` | `char(42)` (hex) |
| `bytes1`–`bytes32` | `char(2 + 2·N)` (hex) — e.g. `bytes32` is `char(66)` |
| `bytes`, `string` | `text` |
| arrays and tuples | `jsonb` |

Integer types map by bit width:

| Postgres column | Unsigned (`uintN`) | Signed (`intN`) |
| --- | --- | --- |
| `smallint` | `uint8` | `int8`, `int16` |
| `integer` | `uint16`, `uint24` | `int24`, `int32` |
| `bigint` | `uint32`–`uint56` | `int40`–`int64` |
| `numeric(78,0)` bigint | `uint64`–`uint256` | `int72`–`int256` |

Pass a mutation table to a Drizzle client to query:

```ts
import { desc } from "drizzle-orm";

const recent = await db
  .select()
  .from(typewriter.schema.transfer_mutations)
  .orderBy(desc(typewriter.schema.transfer_mutations.id))
  .limit(20);
```

#### `typewriter.on()`

```ts
typewriter.on(event, callback): () => void;
```

Subscribes to runtime events; returns an unsubscribe function. There are three events, each with its own payload type.

**`"mutation"` → `MutationEvent`** — fires every time a mutation changes lifecycle status. It is a discriminated union on `status`. Every variant carries `id` (number), `name` (the mutation name), `params`, and `signature`; the rest depends on `status`:

| `status` | Additional fields |
| --- | --- |
| `"received"` | — |
| `"enqueued"` | — |
| `"accepted"` | `isForceInclusion` |
| `"included"` / `"safe"` / `"finalized"` | `isForceInclusion` |
| `"rejected"` | `isForceInclusion`, `error` |

This status set is wider than the happy-path lifecycle in [Server runtime](#server-runtime): `enqueued` occurs for force-included mutations — those a user submits directly onchain via `enqueue()` (see [Force inclusion](#force-inclusion)) — once the runtime detects and reconciles them, and `rejected` (carrying the rejection `error`) when a mutation fails. `isForceInclusion` marks mutations that entered through the force-inclusion queue.

**`"batch"` → `BatchEvent`** — fires when a batch changes status; batch sequencing only. Fields:

- `status` — `"accepted" | "included" | "safe" | "finalized"`
- `id` — number
- `position` — the batch's position in submission order
- `mutations` — the batch's `MutationEvent`s (`accepted` and later; never `enqueued`/`rejected`)
- `forceIncludedMutations?` — force-included mutations settled alongside the batch

**`"block"` → `BlockEvent`** — fires when a submitted block reaches a confirmation depth. Common fields:

- `status` — `"included" | "safe" | "finalized"` (block events never fire for `accepted`, which is pre-block)
- `number` — block number (`bigint`)
- `hash` — block hash
- `timestamp` — block timestamp (`bigint`)
- `transactionHash` — the settlement transaction

The remaining fields depend on sequencing:

- FIFO — `mutations`: the block's `MutationEvent`s.
- batch — `batches`: the block's `BatchEvent`s (excluding `accepted`); and `forceIncludedMutations`.

```ts
const unsubscribe = typewriter.on("mutation", (mutation) => {
  console.log(mutation.id, mutation.status);
});
```

## License

[MIT](./LICENSE)
