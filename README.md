# Typewriter

Typewriter is a framework for crypto apps that need custom transaction sequencing, fast confirmations, and built-in gas sponsorship.

You write Solidity state and mutations. Then, Typewriter runs a server that orders user-signed mutations, executes them locally for acceptance in roughly 50ms, and submits them onchain.

The server is trusted for day-to-day ordering and availability, but it does not control user funds. Users can bypass the server and submit valid mutations directly onchain through force inclusion.

- **Custom sequencing**. Applications define their transaction ordering (fifo or batch).
- **Fast confirmations**. Applications can accept mutations in roughly 50ms, before transactions finalize onchain.
- **Gas sponsorship**. Users sign application mutations while the server pays for settlement transactions.
- **Native accounts**. Credential management, parallel nonces, expirations, permissions, and EIP-712 authorization with P-256, WebAuthn-P256, or secp256k1.
- **Direct control**. No external relayers, sequencers, or builder auctions between users and the application. The application has end-to-end control over what users experience.
- **Local first**. Build rapidly with a powerful local development loop.

> [!WARNING]
> **This project is under active development. Not ready for production use.**
> It is provided for educational purposes and has not been audited. Do not use it in connection with real funds on mainnet without an independent audit.

## Local Development

The latest Foundry release includes Monad support. Start a local Monad Anvil node with:

```bash
anvil --network monad --block-time 0.4
```

## Concepts

### State

Application state lives onchain, where the Solidity state definition serves as the ground truth.

```solidity
struct State {
    uint256 totalSupply;
    mapping(bytes32 => uint256) balances;
}
```

### Mutations

Mutations are app-defined state transitions requested by a user and executed onchain. Updates to application state are done with mutations.

```solidity
struct Transfer {
    bytes32 to;
    uint256 amount;
}

function executeTransfer(State storage state, Transfer memory transfer, bytes32 accountID) {
    state.balances[accountID] -= transfer.amount;
    unchecked {
        state.balances[transfer.to] += transfer.amount;
    }
}
```

### Accounts and Signatures

Typewriter owns the account registry and verifies one fixed EIP-712 `Authorization`
shape for every mutation.

Typewriter supports three signature algorithms:

- P-256
- WebAuthn-P256
- secp256k1

An account has a stable `bytes32` ID and array-indexed credentials. Each
credential stores its key type, public key, expiration, and a `uint256`
permission bitset keyed by mutation ID. Authorizations select a credential,
carry a packed parallel nonce and expiration, and sign the mutation's encoded
data under the deployment's Typewriter EIP-712 domain.

```solidity
struct Authorization {
    bytes32 accountID;
    uint64 credentialID;
    uint256 nonce;
    uint256 expiration;
    bytes signature;
}
```

Account creation, credential addition, and credential removal are built-in
mutations with IDs `253`, `254`, and `255`. App mutation IDs occupy `0` through
`252`.

### Server runtime

A mutation is the framework equivalent of a transaction, but unlike a transaction it is not submitted directly onchain. Instead mutations are submitted to an application server where they can be reordered and accepted quickly, then eventually made durable with onchain execution. Users sign mutations, not transactions; in normal operation the server is the party that submits transactions to the chain. Each mutation is executed locally in an embedded EVM (revm) against the server's copy of contract state, and once the server knows the mutation will succeed onchain it responds `accepted` — usually within milliseconds, before a block is produced.

The lifecycle of a mutation is as follows:
- **received**. The server has received the mutation.
- **accepted**. The server has ordered and executed the mutation locally.
- **included**. The server submitted the mutation onchain and it has been included in a block.
- **safe**. The block that contains the mutation has been marked "safe" by consensus. (See JSON-RPC "safe" tag).
- **finalized**. The block that contains the mutation has been marked "finalized" by consensus. (See JSON-RPC "finalized" tag).

`createTypewriter` starts the runtime and returns a handle for submitting mutations, reading state, and subscribing to events.

`createTypewriter` takes a Solidity entrypoint and runtime config. `TypewriterConfig` requires `address`, `account`, `chainId`, `rpcUrl`, and `database`. Contract metadata (`storageLayout` and app mutations) is derived from the Solidity entrypoint; native account mutations are added automatically. Optional runtime controls are `blockPollingIntervalMs`, `confirmations`, `onFatalError`, and `sequencing`.

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
const accepted = await typewriter.execute({
  name: "Transfer",
  params,
  authorization,
});
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

- [`token`](https://github.com/monad-exp/order-book/tree/main/apps/token) is a minimal token application that demonstrates native P-256 accounts, batch sequencing, minting, and account-owned transfers.
- [`order-book`](https://github.com/monad-exp/order-book/tree/main/apps/order-book) is a full order-book application with custom sequencing, WebAuthn account bootstrap, session keys, deposits, withdrawals, and onchain settlement.

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

All application state is contained in one `struct State` stored in a top-level
variable named `state`. Typewriter stores its account registry separately in a
top-level `accounts` mapping inherited from the base contract. Compiler storage
layout gives the runtime typed proxies for both roots.

```solidity
struct State {
    uint256 totalSupply;
    mapping(bytes32 accountID => uint256 balance) balances;
}
```

> All Solidity data types are supported. Mapping and dynamic keys touched during accepted execution are recovered from the local EVM trace and persisted for read models when their storage slot preimages are available.

#### Mutations

Each mutation is a Solidity library with:
- **`struct [Mutation]` definition**. The app's `dispatch` callback ABI-decodes
  `mutationData` into this struct. Field names and order define the params
  extracted into the manifest.
- **`execute` function**. Applies the mutation to app state using the
  authenticated `accountID`. Account lookup, permissions, expiration, nonce,
  and signature checks have already happened in the base contract.

```solidity
library AddMutation {
    struct Add {
        uint256 amount;
    }

    function execute(State storage state, Add memory add, bytes32) internal {
        state.total += add.amount;
    }
}
```

#### Authorization

The outer EVM transaction is submitted by the scheduler, so mutations carry a
fixed authorization that identifies the user account and credential.

```solidity
struct Authorization {
    bytes32 accountID;
    uint64 credentialID;
    uint256 nonce;
    uint256 expiration;
    bytes signature;
}
```

The signed EIP-712 primary type is
`Authorization(bytes32 accountID,uint64 credentialID,uint256 nonce,uint256 expiration,uint8 mutation,bytes mutationData)`
under domain name `Typewriter`, version `1`, the deployment chain ID, and the
contract address. Dynamic `mutationData` is hashed according to EIP-712.
It is the exact `abi.encode(mutation)` passed to contract execution: one
top-level mutation struct, with no appended account ID.

The nonce packs a `uint192` lane into its high bits and a `uint64` sequence into
its low bits. This allows independent clients to use separate lanes without
serializing every account action. Zero expiration means no expiration; nonzero
authorizations and credentials are valid through their expiration timestamp.

Credentials use a `uint256` permission bitset where bit `mutationID` grants the
corresponding mutation. Credential IDs are stable array indexes. Typewriter
prevents removal of a missing credential or the final active credential.

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

`CreateAccount`, `AddCredential`, and `RemoveCredential` use this same envelope.
`CreateAccount` derives the account ID from
`keccak256(abi.encode(keyType, publicKey))`; that derived value is both the
signed authorization's `accountID` and the wire authorization's `accountID`. The
authorization must also use zero values for `credentialID`, `nonce`, and
`expiration`.
Its signed `mutationData` remains the original `abi.encode(createAccount)`, and
it creates credential `0` with all permissions.

#### Contract structure

The contract inherits from `typewriter/Typewriter.sol`, which supplies native
account storage and validation, the Typewriter EIP-712 domain, scheduler and
force-inclusion protocol, and the external execution entry points. The app owns
only its `State`, app mutation enum, and the `dispatch` callback.

```solidity
import {Typewriter, UnknownMutation} from "typewriter/Typewriter.sol";

contract Token is Typewriter {
    State internal state;

    enum Mutation {
        Add
    }

    constructor(address _scheduler) {
        SCHEDULER = _scheduler;
        FORCE_INCLUSION_DELAY = 658;
    }

    function dispatch(uint8 mutation, bytes memory mutationData, bytes32 accountID)
        internal override
    {
        if (mutation != uint8(Mutation.Add)) revert UnknownMutation(mutation);
        AddMutation.Add memory add = abi.decode(mutationData, (AddMutation.Add));
        AddMutation.execute(state, add, accountID);
    }
}
```

**`state`.** A single non-public storage variable wraps the State struct. Underlying storage slots are read directly so Solidity visibility does not affect framework reads.

**`Mutation` enum.** Designates the valid mutations for the contract.

**`SCHEDULER`.** The privileged address for submitting mutations. Declared in `Typewriter` as `address internal immutable` — the inheriting contract must assign it in the constructor.

**`DOMAIN_SEPARATOR`.** Constructed by the base contract from the fixed
Typewriter name/version, `block.chainid`, and `address(this)`.

**`FORCE_INCLUSION_DELAY`.** The number of blocks that must elapse after a mutation is enqueued before any caller may `forceExecute` it. Declared in `Typewriter` as `uint256 internal immutable` — `Typewriter` does not impose a value, so the inheriting contract must assign it in the constructor. All examples in this repo use `658` blocks (≈4.4 minutes at 0.4 s/block).

**Inherited external ABI.** `execute`, `enqueue`, and `forceExecute` are implemented by `Typewriter` (no app code), but they define the contract's external surface that the runtime and clients depend on:

```solidity
// Scheduler-gated settlement. `forceExecuteIndexes` settles queued
// force-included mutations alongside the batches.
function execute(Batch[] calldata batches, uint256[] calldata forceExecuteIndexes) external;

// User force-inclusion entry point. Pushes a `QueuedMutation` and emits
// `ForceInclusionQueued`.
function enqueue(uint8 mutation, bytes calldata mutationData, bytes calldata authorizationData) external returns (uint256);

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
    bytes authorizationData,
    uint256 enqueuedBlock
);
```

#### `dispatch`

```solidity
function dispatch(uint8 mutation, bytes memory mutationData, bytes32 accountID)
    internal override;
```

For app mutations, Typewriter first validates the account, credential,
expiration, permission, and nonce. It verifies the original `mutationData`
through the fixed authorization envelope, consumes the nonce, and calls
`dispatch` with the authenticated account ID. The callback branches on the app
mutation ID and ABI-decodes the mutation struct. Built-in account mutations are
handled entirely by the base contract.

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

The server entry point exports `createTypewriter`. Its handle contains `state`,
`accounts`, `schema`, `manifest`, `execute`, `on`, and `close`.

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

The Solidity entrypoint must be importable by Bun. At startup, typewriter runs `forge build`, reads the compiled ABI/storage layout/AST, and derives app mutation IDs, params, and typed storage from the contract.

#### `typewriter.manifest`

```ts
typewriter.manifest: {
  chainId: number;
  address: Address;
  mutations: Record<string, { id: number; params: AbiParameter[] }>;
};
```

The serializable manifest contains the deployment and all app/native mutation
metadata needed to authorize mutations. The browser-safe `typewriter/client`
subpath consumes this object. It owns ABI encoding, generic EIP-712 payload
construction, account derivation, nonce arithmetic, and P-256 signature
packing. The app still owns keys, persistence, signing, HTTP, and status
handling.

```ts
import {
  authorizeMutation,
  getAuthorizationPayload,
} from "typewriter/client";

const mutation = {
  name: "Transfer",
  params,
  accountID,
  credentialID: 0n,
  nonce,
  expiration,
};
const payload = getAuthorizationPayload(manifest, mutation);
const signature = await sign(payload);
const submitted = authorizeMutation(mutation, signature);
```

#### `typewriter.execute()`

```ts
typewriter.execute(input: { name, params, authorization }): Promise<{ id }>;
```

Submits an authorized mutation. `name` is the exact Solidity `Mutation` enum
member (or built-in mutation name), `params` matches its struct, and
`authorization` has the fixed native shape. It resolves once accepted and
rejects if contract execution reverts.

```ts
const accepted = await typewriter.execute({
  name: "Transfer",
  params,
  authorization,
});
// accepted.id
```

#### `typewriter.state`

```ts
typewriter.state: StorageProxy<State>;
```

`typewriter.state` resolves the top-level Solidity `state` variable by one proxy
layer. It reads the runtime's local revm-backed storage mirror, so accepted state
is visible before onchain inclusion and leaf accesses return promises.

```ts
const balance = await typewriter.state.balances[accountID];
```

`typewriter.state` reflects locally accepted state, which can be ahead of what is `included` or `finalized` onchain.

#### `typewriter.accounts`

`typewriter.accounts` resolves the base contract's top-level native account
mapping by one proxy layer. Apps can inspect learned account keys, credentials,
and nonce lanes without placing account state inside their own `State` struct.

```ts
const account = typewriter.accounts[accountID];
const credential = account.credentials[0];
const sequence = await account.nonces[lane];
```

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
- **Authorization columns** — fixed `authorization_account_id`,
  `authorization_credential_id`, `authorization_nonce`,
  `authorization_expiration`, and `authorization_signature` columns.

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
