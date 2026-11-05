# Typewriter

Typewriter is a framework for crypto apps that need custom transaction sequencing, fast confirmations, and built-in gas sponsorship.

Developers write business logic for their app with Solidity. Then, Typewriter runs a server that orders user-signed mutations, executes them locally for acceptance within milliseconds, and submits them onchain.

The server is trusted for day-to-day ordering and availability, but it does not control user funds. Users can bypass the server and submit valid mutations directly onchain through force inclusion.

- **Custom sequencing**. Applications define their transaction ordering (fifo or batch).
- **Fast confirmations**. Applications can accept mutations within milliseconds, before transactions finalize onchain.
- **Gas sponsorship**. Users sign application mutations while the server pays for settlement transactions.
- **Native accounts**. Credential management, parallel nonces, expirations, permissions, and EIP-712 authorization with P-256, WebAuthn-P256, or secp256k1.
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
    mapping(bytes32 => uint256) balances;
}
```

### Mutations

Mutations are app-defined state transitions requested by a user and executed onchain. Updates to application state are done with mutations.

```solidity
library TransferMutation {
    struct Transfer {
        bytes32 to;
        uint256 amount;
    }

    function execute(State storage state, Transfer memory transfer, bytes32 accountID) internal {
        state.balances[accountID] -= transfer.amount;
        unchecked {
            state.balances[transfer.to] += transfer.amount;
        }
    }
}
```

### Accounts and Signatures

Typewriter provides a built-in account system. An account represents a user and is identified by a stable `bytes32` ID. Each account can have multiple credentials, which can be added or removed without changing its identity.

A credential grants permission to act on behalf of an account. It contains a public key, permissions specifying which mutations it can authorize, and an optional expiration. Typewriter supports three signature types: P-256, WebAuthn-P256, and secp256k1.

Users sign mutations with a credential to create authorizations. Before executing the mutation onchain, Typewriter verifies the signature, checks permissions, and enforces expirations and replay protection.

Accounts use two-dimensional nonces: a lane and a sequence number within that lane. Separate clients can use independent lanes to submit mutations for the same account without coordinating a single sequence.

### Server runtime

A mutation is the framework equivalent of a transaction, but unlike a transaction it is not submitted directly onchain. Instead mutations are submitted to an application server where they can be reordered and accepted quickly, then eventually made durable with onchain execution. Users sign mutations, not transactions; in normal operation the server is the party that submits transactions to the chain. The server executes each mutation against its own copy of the contract's state, and once it knows the mutation will succeed onchain it responds `accepted` — usually within milliseconds, before a block is produced.

The lifecycle of a mutation is as follows:
- **received**. The server has received the mutation.
- **accepted**. The server has ordered and executed the mutation locally.
- **included**. The server submitted the mutation onchain and it has been included in a block.
- **finalized**. The block that contains the mutation is at or below the chain's `"finalized"` block.

A mutation the server can't accept is **rejected** instead.

`createTypewriter` starts the runtime and returns a handle for submitting mutations, reading state, and subscribing to events.

`createTypewriter` takes a Solidity entrypoint and runtime config. `TypewriterConfig` requires `address`, `account`, `chainId`, `rpcUrl`, and `database`, or just `database` in [dev mode](#local-development). Contract metadata (`storageLayout` and app mutations) is derived from the Solidity entrypoint; native account mutations are added automatically. Optional fields are `hardfork`, `blockPollingIntervalMs`, and `sequencing`.

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
  blockPollingIntervalMs: 200,
  sequencing: {
    order: "fifo",
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

#### Local development

With `dev: true`, typewriter starts its own Anvil (`anvil --network monad`), deploys the app with Anvil's first account as the scheduler, and fills in `address`, `account`, `chainId`, `rpcUrl`, and `hardfork` itself. Leave `address`, `account`, `chainId`, and `rpcUrl` unset; setting any of them with `dev` is an error.

```ts
const typewriter = await createTypewriter(Token, {
  dev: true,
  database: { url: databaseUrl },
});
```

Dev mode is ephemeral: each process deploys to a new chain and keeps its state in its own database schema, `typewriter_dev_<random>`, and gives clients the matching `manifest.deploymentKey`, so several dev processes can share one database. Stopping the process drops the schema and stops Anvil. Anvil keeps only recent history, in memory, so a long-running dev chain stays the same size; reads of old blocks fail. It needs `anvil` from Foundry on the `PATH`.

To run against an Anvil you start yourself, use `anvil --network monad` and set `hardfork` (for example `"MonadTen"`), since Anvil's chain ID has no Monad hardfork schedule.

#### Sequencing

Sequencing controls the order mutations are accepted by the server and included onchain. Typewriter ships two sequencing modes: FIFO and batch. FIFO is the default when `sequencing` is omitted.

##### FIFO

```ts
import { createTypewriter } from "typewriter";

const app = await createTypewriter(Token, {
  // ... more config
  sequencing: {
    order: "fifo",
  },
});
```

Each call to `typewriter.execute()` immediately executes the mutation against local state and returns the accepted mutation, or throws an error if the mutation is rejected. Accepted mutations are submitted onchain right away; see [Submission](#submission).

Onchain inclusion order matches the order mutations were executed with `typewriter.execute()`.

##### Batch

```ts
import { createTypewriter } from "typewriter";

const app = await createTypewriter(OrderBook, {
  // ... more config
  sequencing: {
    order: "batch",
    batchIntervalMs: 50,
    batchOrder: ["CloseOrder", "LimitOrder", "MarketOrder"],
  }
});
```

Each call to `typewriter.execute()` enqueues the mutation and returns the accepted mutation once the next batch is processed, or throws an error if the mutation is rejected. Every `batchIntervalMs` (default `50`), all enqueued mutations are gathered into a batch, ordered according to `batchOrder`, and accepted or rejected. Accepted batches are submitted onchain right away; see [Submission](#submission).

`batchOrder` lists `Mutation` enum member names. Built-in account mutations always come first, and mutations not in `batchOrder` come last, in the order they were received. Within a batch, mutations execute in that order; across batches, batches are submitted in the order they were accepted.

#### Submission

Typewriter sends a settlement transaction as soon as a batch is accepted, without waiting for earlier settlements to be included, so several land in each block. Each batch settles in its own transaction, followed in that transaction by any [force-included](#force-inclusion) mutations waiting at the time. A batch that would outgrow Monad's 30M transaction gas cap continues in a new batch, and a mutation too large for any transaction is rejected with `MutationTooLargeError`.

Each settlement names the contract's `executionHash` it starts from and the timestamp the server executed it at. `executionHash` accumulates every executed mutation, so a settlement executes only on exactly the state the server simulated it against. A settlement is sent to every RPC provider at once and sent again until it lands.

A settlement reverts only when it lands more than `MAX_SETTLEMENT_DELAY` (60) seconds late, and then every settlement sent after it reverts too. The server stops sending, waits for every settlement in flight to land, and executes the reverted mutations again at the current block. Each one emits `accepted` again, possibly with a new `executionIndex`, or `rejected` if it fails now, for example because its authorization expires too soon. Any other revert stops the server.

## Examples

- [`token`](https://github.com/monad-developers/typewriter/tree/main/apps/token) is a minimal token application that demonstrates native P-256 accounts, batch sequencing, minting, and account-owned transfers.
- [`order-book`](https://github.com/monad-developers/typewriter/tree/main/apps/order-book) is a full order-book application with custom sequencing, WebAuthn account bootstrap, session keys, deposits, withdrawals, and onchain settlement.

## Failure modes

### Reorgs

A mutation can be included in a block and later removed by a [chain reorganization](https://www.alchemy.com/overviews/what-is-a-reorg). By definition, this only affects mutations that have not reached the `finalized` state.

The server does not yet recover from a reorg that removes a block containing its settlements or enqueued mutations: it stops with `SettlementReorgedError` or `EnqueueReorgedError`.

### Force inclusion

Users can bypass the server entirely and submit their mutations directly to the chain with _force inclusion_. Force inclusion is not meant to replace server-based mutation processing during normal operation. It exists as an escape hatch so that a valid mutation cannot be censored indefinitely.

Force inclusion uses a two-stage, enqueue then execute, mechanism. First, a user registers their mutation onchain by calling the `enqueue()` function.

When the server sees an enqueued mutation, it executes it and settles it onchain after the next batch. Enqueued mutations don't emit `"mutation"` events or get rows in the [mutation tables](#typewriterschema).

If the server is completely offline, the user may call `forceExecute()` on their queued mutation after the `FORCE_INCLUSION_DELAY`.

### Offchain/onchain divergence

Mutations are executed and accepted on the server before they are executed onchain. Onchain divergence happens when the server accepts a mutation, but the same mutation behaves differently (and reverts) when executed onchain.

Typewriter rules out its causes: the contract runs each settlement at the timestamp the server executed it at, and the app contract can't read other contracts or environment values that differ onchain (see [Determinism](#determinism)). A settlement can still revert when it lands too late; see [Submission](#submission).

### Restarts

Accepted mutations are persisted to Postgres before `execute()` resolves, and the server restores its state from them on startup.

What a restart does with mutations that were accepted but not yet finalized is not decided yet. Startup fails if the scheduler account has pending transactions, or if the chain has executed mutations the database doesn't have, for example after a user calls `forceExecute()` while the server is down.

## API reference

### Contract requirements

In order to be Typewriter-compliant, a smart contract must be written with Solidity and implement certain data structures and methods.

#### State

All application state is contained in one `struct State` stored in a top-level
variable named `state`. Typewriter keeps its account registry separately, in an
`accounts` mapping inherited from the base contract.

```solidity
struct State {
    uint256 totalSupply;
    mapping(bytes32 accountID => uint256 balance) balances;
}
```

> Value types, enums, structs, fixed and dynamic arrays, mappings, `bytes`, and `string` are supported, nested in any combination. Fixed-point numbers, function types, contract and interface types, user-defined value types, and `bytes`/`string`/enum mapping keys are not supported and fail loudly. `Object.keys` on a mapping lists the keys that accepted mutations have read or written.

#### Mutations

Each `Mutation` member `X` needs exactly one library named `XMutation`, in the
entrypoint file or a file it imports, with:
- **`struct X`**, the mutation's params. Field names and order define the
  params in the manifest. Fields can be any ABI type: value types, `bytes`,
  `string`, arrays, and nested structs. Enums become `uint8`, user-defined
  value types their underlying type, and contracts and interfaces `address`.
- **`function execute(State storage state, X memory mutation, bytes32 accountID) internal`**,
  with no return value, where `State` is the type of the app's `state`
  variable. Applies the mutation to app state using the authenticated
  `accountID`. Account lookup, permissions, expiration, nonce, and signature
  checks have already happened in the base contract.

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

#### Accounts and credentials

The `Typewriter` base contract provides the account registry and credential management.

Accounts are stored in the inherited `accounts` mapping, separately from the
application's `State`:

```solidity
mapping (bytes32 => Account) accounts;

struct Account {
    mapping(uint192 => uint64) nonces;
    Credential[] credentials;
    uint64 activeCredentials;
}

struct Credential {
    uint40 expiration;
    KeyType keyType;
    uint256 permissions;
    bytes publicKey;
}

enum KeyType {
    P256,
    WebAuthnP256,
    Secp256k1
}
```

Each credential belongs to an account and grants permission to sign mutations
on its behalf. `keyType` selects `P256`, `WebAuthnP256`, or `Secp256k1`.
`permissions` is a bitset: bit `mutationID` grants permission to authorize that
mutation. `expiration` is a Unix timestamp in seconds; `0` means no expiration.

A credential's ID is its array index. Adding a credential appends a new entry;
removing one clears its slot without changing other IDs or the account ID.
`activeCredentials` counts credentials that have not been removed, including
expired credentials. Typewriter prevents removal of a missing credential or
the final remaining credential.

Account creation and credential management are built-in mutations:

| Mutation | ID | Parameters |
| --- | --- | --- |
| `CreateAccount` | `253` | `KeyType keyType`, `bytes publicKey` |
| `AddCredential` | `254` | `uint40 expiration`, `KeyType keyType`, `uint256 permissions`, `bytes publicKey` |
| `RemoveCredential` | `255` | `uint64 credentialID` |


`CreateAccount` derives the account ID as
`keccak256(abi.encode(keyType, publicKey))` and creates credential `0` with all
permissions and no expiration. The account ID remains unchanged if this
credential is later removed.

#### Authorization

An authorization is a user's signed approval for a specific mutation. It
identifies the account and the credential used to sign. Typewriter handles
decoding and verification internally, then passes an authenticated
`bytes32 accountID` to `dispatch()`. Application mutation code does not receive
the authorization or implement these checks.

```solidity
struct Authorization {
    bytes32 accountID;
    uint64 credentialID;
    uint256 nonce;
    uint40 expiration;
    bytes signature;
}
```

`signature` contains the credential-specific encoded signature over the EIP-712 authorization digest. The exact primary type is:

```text
Authorization(bytes32 accountID,uint64 credentialID,uint256 nonce,uint40 expiration,uint8 mutation,bytes mutationData)
```

The domain is `{ name: "Typewriter", version: "1", chainId, verifyingContract }`,
using the deployment's chain ID and contract address. This binds the signature
to that deployment.

**Signature encoding.** The selected credential's `keyType` determines the
expected key and signature bytes:

| `keyType` | Stored `publicKey` | Encoded `signature` |
| --- | --- | --- |
| `P256` (`0`) | 65-byte uncompressed key (`0x04 \|\| X \|\| Y`) or `abi.encode(uint256 x, uint256 y)` | `abi.encode(uint256 r, uint256 s)` |
| `WebAuthnP256` (`1`) | Same as `P256` | `abi.encode(bytes authData, bytes clientDataJSON, uint256 challengeOffset, uint256 r, uint256 s)` |
| `Secp256k1` (`2`) | `abi.encode(address)` | `abi.encode(uint8 v, bytes32 r, bytes32 s)` with `v` equal to `27` or `28` |

For `Secp256k1`, Typewriter calls `ecrecover` on `digest` and requires a nonzero
address matching the stored address. For `P256`, it verifies `(r, s)` over
`sha256(digest)`. For `WebAuthnP256`, it checks that the 43-byte, unpadded
base64url encoding of `digest` appears in `clientDataJSON` at `challengeOffset`,
then verifies `(r, s)` over `sha256(authData || sha256(clientDataJSON))`.
Both P-256 paths need the chain's P-256 precompile at `0x100`, which Monad provides.

**Verification.** For an existing account, the base contract performs these
checks before executing the mutation:

1. The account exists, and `credentialID` selects a credential that has not been removed.
2. Neither the authorization nor the credential has expired. Both expirations are Unix timestamps in seconds; `0` means no expiration, and nonzero values must be greater than or equal to the settlement's timestamp (see below).
3. The credential permits the mutation: `permissions & (uint256(1) << mutation)` is nonzero.
4. The nonce sequence matches the account's next expected sequence for its lane and is less than `type(uint64).max`.
5. The signature is valid for the EIP-712 digest and the credential's key.

If any check fails, execution reverts. After verification, Typewriter increments
the lane's sequence and executes the mutation.

**Two-dimensional nonces.** The nonce packs a `uint192` lane into its high bits
and a `uint64` sequence into its low bits:

```solidity
uint256 nonce = (uint256(lane) << 64) | uint256(sequence);
```

The next expected sequence is stored in `accounts[accountID].nonces[lane]` and
starts at `0`. Lanes are shared across the account's credentials. Separate
clients can choose different lanes to submit mutations without coordinating a
single sequence; clients using the same lane must coordinate.

**Account creation.** `CreateAccount` uses the same wire format and EIP-712
payload, but verifies against the key supplied in the mutation because there
is no existing credential. The account must not already exist, the key and
signature must be nonempty, and `accountID` must equal
`keccak256(abi.encode(keyType, publicKey))`. `credentialID`, `nonce`, and
`expiration` must all be `0`. Creation does not consume a nonce.

#### Contract structure

The contract inherits from `typewriter/Typewriter.sol`, which supplies accounts
and authorization, the scheduler, and force inclusion. The app owns only its
`state`, its `Mutation` enum, its mutation libraries, and the `dispatch`
callback.

```solidity
import {Typewriter, UnknownMutation} from "typewriter/Typewriter.sol";

contract Token is Typewriter {
    State internal state;

    enum Mutation {
        Add
    }

    constructor(address _scheduler) Typewriter(_scheduler) {}

    function dispatch(uint8 mutation, bytes memory mutationData, bytes32 accountID)
        internal override
    {
        if (mutation == uint8(Mutation.Add)) {
            AddMutation.Add memory add = abi.decode(mutationData, (AddMutation.Add));
            AddMutation.execute(state, add, accountID);
        } else {
            revert UnknownMutation(mutation);
        }
    }
}
```

**`FORCE_INCLUSION_DELAY`.** The number of seconds that must elapse after a mutation is enqueued before any caller may `forceExecute` it. It defaults to `5 minutes`; an app that needs a different delay reassigns it in its constructor:

```solidity
constructor(address scheduler) Typewriter(scheduler) {
    FORCE_INCLUSION_DELAY = 10 minutes;
}
```

**Force inclusion.** `Typewriter` implements `enqueue` and `forceExecute`, which let users bypass the server (see [Force inclusion](#force-inclusion)):

```solidity
// Queues a mutation onchain and emits `ForceInclusionQueued`.
function enqueue(uint8 mutation, bytes calldata mutationData, bytes calldata authorizationData) external returns (uint256);

// Callable by anyone once `FORCE_INCLUSION_DELAY` seconds have elapsed since the entry was enqueued.
function forceExecute(uint256 index) external;

event ForceInclusionQueued(
    uint256 index,
    uint8 mutation,
    bytes mutationData,
    bytes authorizationData,
    uint40 enqueuedTimestamp
);
```

#### `dispatch`

```solidity
function dispatch(uint8 mutation, bytes memory mutationData, bytes32 accountID)
    internal override;
```

For app mutations, Typewriter first [verifies the authorization](#authorization)
and consumes the nonce, then calls `dispatch` with the authenticated account ID.
`dispatch` branches on the mutation ID, ABI-decodes `mutationData` into the
mutation's struct, and calls its library's `execute`. Built-in account
mutations are handled entirely by the base contract.

The entrypoint file must define exactly one contract that inherits
`Typewriter`. That contract must:

- inherit only `Typewriter`, and not be abstract;
- declare exactly `constructor(address scheduler)` and pass `scheduler` to `Typewriter(scheduler)`; the body may do more, but it takes no other arguments, so typewriter can deploy any app;
- declare `enum Mutation` inside itself, with at most 253 members and none named like a built-in mutation;
- keep all its storage in `state` (`constant`s are allowed), with no function-typed fields;
- add no `public` or `external` functions or variables;
- implement `dispatch` by calling `internal` library functions only, such as each mutation library's `execute`;
- execute deterministically (see [Determinism](#determinism)).

Typewriter checks these rules at startup and names the one that's broken.

#### Determinism

The server executes a mutation before it settles: against the app contract
alone, in the last block the server saw, with unlimited gas and a gas price of
0, called by the scheduler. Code whose result depends on anything else can
diverge onchain, so Typewriter rejects it at startup. The check covers the app
contract's functions, each mutation library's `execute`, and every function,
modifier, and operator they reach; it trusts Typewriter.sol. That code must not
use:

- `block.*` other than `block.chainid`, or `blockhash` or `blobhash`: the block a mutation settles in isn't the one the server executed it in;
- `msg.*` or `tx.*`: the server calls as the scheduler, but anyone can call `forceExecute`, and settlement batches the calldata;
- `gasleft()`: the server runs with unlimited gas;
- another contract or account: external calls, `.call`/`.staticcall`/`.delegatecall`, `.send`/`.transfer`, `.balance`, `.code`/`.codehash`, `new`, or `selfdestruct`;
- inline assembly, which the check can't read;
- Typewriter's own state and functions (`accounts`, `queue`, `executionIndex`, `executionHash`, `_execute`, …).

Library code a mutation doesn't reach, such as an unused assembly helper, isn't checked.

`block.number` and `block.timestamp` are rejected too: a settlement carries
the timestamp the server executed it at, and the contract checks expirations
against it, but app code doesn't see it. The contract rejects a settlement
whose timestamp is ahead of the block it lands in, or more than
`MAX_SETTLEMENT_DELAY` (60) seconds behind it. The server accepts only
authorizations and credentials that expire at least that long after the block
it executes them in, so none executes after it expires. `forceExecute` checks
expirations against the block it lands in.

### Server runtime

The server entry point exports `createTypewriter`. Its handle contains `state`,
`accounts`, `schema`, `manifest`, `execute`, and `on`. The runtime stops when
the process receives `SIGINT` or `SIGTERM`, and the process exits if the
runtime fails.

#### `createTypewriter()`

```ts
function createTypewriter(
  entrypoint: TypewriterSolidityEntrypoint,
  config: TypewriterConfig,
): Promise<Typewriter>;
```

Starts the runtime and resolves to the `Typewriter` handle once it is ready to accept mutations (see the [Server runtime](#server-runtime) example for a full call).

**`TypewriterConfig`.** Required fields, except in [dev mode](#local-development) (`dev: true`), where typewriter fills in all but `database`:

- `address` — the deployed Typewriter contract.
- `account` — the scheduler `PrivateKeyAccount`; signs and submits the onchain `execute` transactions.
- `chainId` — number.
- `rpcUrl` — `string | string[]`.
- `database` — `{ url, maxConnections?, statementTimeoutMs?, idleInTransactionTimeoutMs? }` (Postgres; both timeouts default to `30000`).

Optional fields:

- `hardfork` — the EVM hardfork mutations execute under. It defaults to the Monad mainnet or testnet schedule for `chainId`, so any other chain, such as your own Anvil, needs it.
- `blockPollingIntervalMs` — default `200`.
- `sequencing` — see [Sequencing](#sequencing); defaults to FIFO.

The Solidity entrypoint must be importable by Bun and belong to a Foundry project, with `forge` on the `PATH`. At startup, typewriter builds the project and derives mutation IDs, params, and typed storage from the contract.

**Logging.** Two environment variables control runtime logs:

- `TYPEWRITER_LOG_LEVEL` — `"trace" | "debug" | "info" | "warn" | "error"`. Default `"info"`.
- `TYPEWRITER_LOG_FORMAT` — `"pretty" | "json"`. Default `"json"` when `NODE_ENV` is `"production"`, else `"pretty"`.

An invalid value throws when the server module loads.

#### `typewriter.manifest`

```ts
typewriter.manifest: {
  chainId: number;
  address: Address;
  deploymentKey: string;
  mutations: Record<string, { id: number; params: AbiParameter[] }>;
};
```

`deploymentKey` identifies the deployment; scope browser storage, such as stored account keys, by it. It is `<chainId>_<address>`, except in [dev mode](#local-development), where every chain deploys to the same address and each process gets a random `dev_<random>` key. A browser therefore never reuses an account from a dev chain that is gone.

The serializable manifest contains the deployment and all app/native mutation
metadata needed to authorize mutations. The browser-safe `typewriter/client`
subpath consumes this object. It owns ABI encoding, generic EIP-712 payload
construction, account derivation, nonce arithmetic, and P-256 and secp256k1
signature packing. The app still owns keys, persistence, signing, HTTP, and
status handling.

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
typewriter.execute(input: { name, params, authorization }): Promise<{ executionIndex }>;
```

Submits an authorized mutation. `name` is the exact Solidity `Mutation` enum
member (or built-in mutation name), `params` matches its struct, and
`authorization` has the fixed native shape. It resolves once the mutation is
accepted and persisted. `executionIndex` (`bigint`) is the mutation's position
in the onchain execution order and the primary key of its row in the mutation
tables; a [late settlement](#submission) can move it.

It rejects with:

- `UnknownMutationError` — `name` is not a mutation.
- `EncodeMutationError` — `params` or `authorization` doesn't match its ABI shape.
- `MutationRevertedError` or `MutationHaltedError` — contract execution failed, for example on a bad signature or nonce.
- `MutationTooLargeError` — the mutation needs more gas than a transaction allows.
- `TypewriterStoppedError` — the runtime stopped before accepting it.

The server also rejects an authorization or credential that expires less than
`MAX_SETTLEMENT_DELAY` seconds after the current block (see
[Determinism](#determinism)).

```ts
const accepted = await typewriter.execute({
  name: "Transfer",
  params,
  authorization,
});
// accepted.executionIndex
```

#### `typewriter.state`

```ts
typewriter.state: StorageView<State>;
```

`typewriter.state` reads the app's `state` variable as the server has accepted
it, so a mutation's effects are visible as soon as it is accepted, before
onchain inclusion. Reads are synchronous.

```ts
const balance = typewriter.state.balances[accountID];
```

`typewriter.state` reflects locally accepted state, which can be ahead of what is `included` or `finalized` onchain.

#### `typewriter.accounts`

`typewriter.accounts` reads the base contract's `accounts` mapping, so apps can
inspect account credentials and nonce lanes.

```ts
const account = typewriter.accounts[accountID];
const credential = account.credentials[0];
const sequence = account.nonces[lane];
```

#### `typewriter.schema`

```ts
typewriter.schema: TypewriterMutationSchema;
```

The [Drizzle](https://orm.drizzle.team) tables the runtime generates and migrates for this deployment. typewriter owns these tables; apps read from them to build read models (decoded mutation history, per-account views, and so on).

One table per Solidity `Mutation` enum member, named `<name>_mutations` with the runtime mutation name lowercased — `Mutation.Transfer` becomes `typewriter.schema.transfer_mutations`, `Mutation.MarketOrder` becomes `marketorder_mutations`. A row is written when a mutation is `accepted`, and its block columns are set when it is `included`; `received` and `rejected` mutations are not persisted here. A mutation is finalized once the chain's `"finalized"` block reaches its `block_number`. The tables live in the Postgres schema `typewriter_<chainId>_<address>`.

Every mutation table starts with the same **lifecycle columns**:

| Column | Type | Notes |
| --- | --- | --- |
| `execution_index` | `bigint`, primary key | the mutation's position in the onchain execution order; matches the `typewriter.execute()` result and event `executionIndex` |
| `accepted_at` | `timestamp with time zone`, defaults to now | |
| `block_number` | `bigint` | inclusion block; null until included |
| `block_hash` | `char(66)` (hex) | null until included |
| `block_timestamp` | `bigint` | null until included |
| `transaction_index` | `integer` | null until included |
| `transaction_hash` | `char(66)` (hex) | the settlement transaction; null until included |

Then two groups of payload columns:

- **Param columns** — one per field of the mutation's struct, named after the field (an unnamed field becomes `arg<index>`).
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
  .orderBy(desc(typewriter.schema.transfer_mutations.execution_index))
  .limit(20);
```

#### `typewriter.on()`

```ts
typewriter.on(event, callback): () => void;
```

Subscribes to runtime events; returns an unsubscribe function. There are three events, each with its own payload type.

**`"mutation"` → `MutationEvent`** — fires every time a mutation changes lifecycle status. It is a discriminated union on `status`. Every variant carries `name` (the mutation name), `params`, and `authorization` (including `authorization.signature`); the rest depends on `status`:

| `status` | Additional fields |
| --- | --- |
| `"received"` | — |
| `"accepted"` | `executionIndex` |
| `"included"` / `"finalized"` | `executionIndex`, `blockNumber`, `blockHash`, `blockTimestamp`, `transactionHash`, `transactionIndex` |
| `"rejected"` | `error` |

`executionIndex` and the block fields match the `execution_index`, `block_*` and `transaction_*` columns of the mutation's row. [Force-included](#force-inclusion) mutations don't emit events.

**`"batch"` → `BatchEvent`** — fires when a batch changes status; batch sequencing only. Fields:

- `status` — `"accepted" | "included" | "finalized"`
- `id` — number
- `mutations` — the batch's `MutationEvent`s, with the same `status` as the batch

**`"block"` → `BlockEvent`** — fires when a block with the app's settlements is included or finalized. Common fields:

- `status` — `"included" | "finalized"` (block events never fire for `accepted`, which is pre-block)
- `number` — block number (`bigint`)
- `hash` — block hash
- `timestamp` — block timestamp (`bigint`)

A block event covers every settlement transaction of the app in that block, in transaction order; each mutation carries its own `transactionHash` and `transactionIndex`. Each block fires `"included"` once and `"finalized"` once.

The remaining fields depend on sequencing:

- FIFO — `mutations`: the block's `MutationEvent`s.
- batch — `batches`: the block's `BatchEvent`s.

With FIFO sequencing, `on("batch", ...)` is a type error.

```ts
const unsubscribe = typewriter.on("mutation", (mutation) => {
  console.log(mutation.name, mutation.status);
});
```

## License

[MIT](./LICENSE)
