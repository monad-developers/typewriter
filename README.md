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

The server keeps its own copy of this state, updated as soon as it accepts each mutation.

```ts
const typewriter = await createTypewriter(Token, config);

typewriter.state.totalSupply;
//               ^? bigint
typewriter.state.balances[accountID];
//                       ^? bigint
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

Users sign mutations and send them to the server, which submits them with `typewriter.execute()`. It resolves as soon as the server accepts the mutation, and throws if the mutation is rejected:

```ts
await typewriter.execute({
  name: "Transfer",
  params: { to, amount: 10n * 10n ** 18n },
  authorization, // the user's signature, see below
});
```

### Accounts and Signatures

Typewriter has a built-in account system. An account is identified by a stable `bytes32` ID and holds credentials: P-256, WebAuthn-P256, or secp256k1 keys, each limited to certain mutations and optionally expiring. Credentials can be added and removed without changing the account's ID.

Users sign each mutation with a credential. The contract checks the signature, permissions, expiration, and nonce before executing it. Nonces have a lane and a sequence within it, so separate clients can sign for the same account without coordinating.

### Server runtime

A mutation is the framework equivalent of a transaction, but unlike a transaction it is not submitted directly onchain. Instead mutations are submitted to an application server where they can be reordered and accepted quickly, then eventually made durable with onchain execution. Users sign mutations, not transactions; in normal operation the server is the party that submits transactions to the chain. The server executes each mutation against its own copy of the contract's state, and once it knows the mutation will succeed onchain it responds `accepted`, before a transaction is created or signed.

The lifecycle of a mutation is as follows:
- **received**. The server has received the mutation.
- **accepted**. The server has ordered and executed the mutation locally.
- **included**. The server submitted the mutation onchain and it has been included in a block.
- **finalized**. The block that contains the mutation is at or below the chain's `"finalized"` block.

A mutation the server can't accept is **rejected** instead.

`createTypewriter` starts the runtime from a contract and a config, and returns a handle for submitting mutations, reading state, and subscribing to events. See [`createTypewriter()`](#createtypewriter) for every option.

```ts
import { createTypewriter } from "typewriter";
import { privateKeyToAccount } from "viem/accounts";
import Token from "../contracts/src/Token.sol";

const typewriter = await createTypewriter(Token, {
  address, // the deployed contract
  account: privateKeyToAccount(privateKey), // the scheduler, which submits transactions
  chainId,
  rpcUrl,
  database: { url: databaseUrl },
});

// ... serve `typewriter.execute()` and `typewriter.state`

typewriter.on("mutation", (mutation) => {
  console.log(mutation.name, mutation.status);
});
```

> Onchain submission is gated to a single scheduler address that the server controls (see [Contract structure](#contract-structure)). Because no one else can submit transactions, the server can simulate a mutation locally and trust the result will hold onchain — which is what lets it respond `accepted` before a block is produced.

#### Local development

With `dev: true`, typewriter starts a local Anvil, deploys the contract to it, and fills in the chain config itself, so only a database is needed:

```ts
const typewriter = await createTypewriter(Token, {
  dev: true,
  database: { url: databaseUrl },
});
```

Each dev process gets a fresh chain and its own database schema, both gone when it stops, so several can share one database. It needs `anvil` from [Foundry](https://getfoundry.sh) on the `PATH`.

#### Sequencing

Sequencing controls the order mutations are accepted by the server and included onchain. Typewriter ships two sequencing modes: FIFO and batch. FIFO is the default when `sequencing` is omitted.

##### FIFO

```ts
const typewriter = await createTypewriter(Token, {
  // ... more config
  sequencing: { order: "fifo" },
});
```

Each call to `typewriter.execute()` executes the mutation right away. Mutations are included onchain in the order they were accepted.

##### Batch

```ts
const typewriter = await createTypewriter(OrderBook, {
  // ... more config
  sequencing: {
    order: "batch",
    batchIntervalMs: 50,
    batchOrder: ["CloseOrder", "LimitOrder", "MarketOrder"],
  },
});
```

Mutations wait for the next batch. Every `batchIntervalMs`, the server gathers them, orders them by `batchOrder` (here, every close before any limit order, and every limit order before any market order), and accepts or rejects each one. `typewriter.execute()` resolves when its batch is processed.

#### Submitting transactions

The server submits accepted mutations onchain itself, in transactions signed and paid for by the scheduler account, so users never need gas. It sends a transaction as soon as mutations are accepted, without waiting for earlier ones to be included, so several land in each block.

Typewriter manages the scheduler's nonces, estimates gas and fees, splits batches too big for one transaction, rebroadcasts transactions until they land, and follows them through reorgs to finality. If a transaction lands too late to execute, Typewriter executes its mutations again.

## Examples

- [`token`](https://github.com/monad-developers/typewriter/tree/main/apps/token) is a minimal token application that demonstrates native P-256 accounts, minting, and account-owned transfers.
- [`order-book`](https://github.com/monad-developers/typewriter/tree/main/apps/order-book) is a full order-book application with custom sequencing, WebAuthn account bootstrap, session keys, deposits, withdrawals, and onchain settlement.

## Failure modes

### Reorgs

A mutation can be included in a block and later removed by a [chain reorganization](https://www.alchemy.com/overviews/what-is-a-reorg). By definition, this only affects mutations that have not reached the `finalized` state.

When a reorg is detected, mutations may move backwards in the mutation lifecycle (accepted => included => finalized). They are re-processed against the new canonical chain and re-emitted with their updated lifecycle status.

> Coming soon: As a protection against exposing user-facing data that may be reorged, apps can choose to use later lifecycle stages, such as `"included"` or `"finalized"`, to serve read requests or resolve `execute()` promises.

### Force inclusion

Users can bypass the server entirely and submit their mutations directly to the chain with _force inclusion_. Force inclusion is not meant to replace server-based mutation processing during normal operation. It exists as an escape hatch so that a valid mutation cannot be censored indefinitely.

Force inclusion uses a two-stage, enqueue then execute, mechanism. First, a user registers their mutation onchain by calling the `enqueue()` function.

When the server sees an enqueued mutation, it executes it and settles it onchain with the next batch. Enqueued mutations don't emit `"mutation"` events or get rows in the [mutation tables](#typewriterschema).

If the server is completely offline, the user may call `forceExecute()` on their queued mutation after the `FORCE_INCLUSION_DELAY`.

### Offchain/onchain divergence

Mutations are executed and accepted on the server before they are executed onchain. Onchain divergence happens when the server accepts a mutation, but the same mutation behaves differently (and reverts) when executed onchain.

Typewriter rules out its causes: the contract runs each settlement at the timestamp the server executed it at, and the app contract can't read other contracts or environment values that differ onchain (see [Determinism](#determinism)). A transaction can still revert when it lands too late; see [Submitting transactions](#submitting-transactions).

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
Both P-256 paths need the chain's P-256 precompile at `0x100`.

**Verification.** For an existing account, the base contract performs these
checks before executing the mutation:

1. The account exists, and `credentialID` selects a credential that has not been removed.
2. Neither the authorization nor the credential has expired. Both expirations are Unix timestamps in seconds; `0` means no expiration, and nonzero values must be greater than or equal to the settlement's timestamp (see **Expirations** under [Authorization](#authorization)).
3. The credential permits the mutation: `permissions & (uint256(1) << mutation)` is nonzero.
4. The nonce sequence matches the account's next expected sequence for its lane and is less than `type(uint64).max`.
5. The signature is valid for the EIP-712 digest and the credential's key.

If any check fails, execution reverts. After verification, Typewriter increments
the lane's sequence and executes the mutation.

**Expirations.** A settlement carries the timestamp the server executed it at,
and the contract checks expirations against that timestamp, so a mutation
executes onchain exactly as the server accepted it. A settlement that lands
more than `MAX_SETTLEMENT_DELAY` (60) seconds after its timestamp reverts, so
the server only accepts authorizations and credentials that expire at least 60
seconds after its latest block. `forceExecute` checks expirations against the
block it lands in.

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
- declare exactly `constructor(address scheduler)` and pass `scheduler` to `Typewriter(scheduler)`; the body may do more, but it takes no other arguments;
- declare `enum Mutation` inside itself, with at most 253 members and none named like a built-in mutation;
- keep all its storage in `state` (`constant`s are allowed), with no function-typed fields;
- add no `public` or `external` functions or variables;
- implement `dispatch` by calling `internal` library functions only, such as each mutation library's `execute`;
- execute deterministically (see [Determinism](#determinism)).

Typewriter checks these rules at startup and names the one that's broken.

#### Determinism

The server executes a mutation locally before it settles. Code whose result
depends on anything but the app's state and the mutation can diverge onchain,
so Typewriter rejects it at startup. The check covers the app
contract's functions, each mutation library's `execute`, and every function,
modifier, and operator they reach; it trusts Typewriter.sol. That code must not
use:

- `block.*` other than `block.chainid`, or `blockhash` or `blobhash`: the block a mutation settles in isn't the one the server executed it in;
- `msg.*` or `tx.*`: the server calls as the scheduler, but anyone can call `forceExecute`, and settlement batches the calldata;
- `gasleft()`;
- another contract or account: external calls, `.call`/`.staticcall`/`.delegatecall`, `.send`/`.transfer`, `.balance`, `.code`/`.codehash`, `new`, or `selfdestruct`;
- inline assembly, which the check can't read;
- Typewriter's own state and functions (`accounts`, `queue`, `executionIndex`, `executionHash`, `_execute`, …).

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

- `dev` — starts Anvil (`anvil --network monad`), deploys the app with Anvil's first account as the scheduler, and fills in `address`, `account`, `chainId`, `rpcUrl`, and `hardfork`. Setting any of the first four with `dev` is an error. The deployment lives in the database schema `typewriter_dev_<random>`, which is dropped with Anvil when the process stops. Anvil keeps only recent history, so reads of old blocks fail.
- `hardfork` — the EVM hardfork mutations execute under. It defaults to the Monad mainnet or testnet schedule for `chainId`, so any other chain, such as a separately started Anvil, needs it (for example `"MonadTen"`).
- `blockPollingIntervalMs` — default `200`.
- `sequencing` — `{ order: "fifo" }` (the default) or `{ order: "batch", batchIntervalMs?, batchOrder }`; see [Sequencing](#sequencing). `batchIntervalMs` defaults to `50`. `batchOrder` lists `Mutation` names; built-in account mutations always come first, and mutations not listed come last, in the order they were received.

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
typewriter.execute(input: { name, params, authorization }): Promise<void>;
```

Submits an authorized mutation. `name` is the exact Solidity `Mutation` enum
member (or built-in mutation name), `params` matches its struct, and
`authorization` has the fixed native shape. It resolves once the mutation is
accepted and persisted. Its position in the onchain execution order, the
`executionIndex` of its mutation events, can change until it is finalized.

The server also rejects an authorization or credential that expires less than
`MAX_SETTLEMENT_DELAY` seconds after the current block (see
**Expirations** under [Authorization](#authorization)).

```ts
await typewriter.execute({
  name: "Transfer",
  params,
  authorization,
});
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
| `execution_index` | `bigint`, primary key | the mutation's position in the onchain execution order; matches the event `executionIndex` |
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

> [Force-included](#force-inclusion) mutations don't emit events.

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
