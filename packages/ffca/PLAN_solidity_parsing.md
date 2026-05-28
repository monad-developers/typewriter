# Solidity Parsing And Generated Contracts Plan

Working notes for tightening the integration between ffca's server runtime and
the Solidity contracts it executes.

## Problem

The server currently expects the deployed contract to implement several ffca
protocol rules correctly:

- mutation dispatch
- deterministic execution
- scheduler access control
- EIP-712 digest and signature validation flow
- force-inclusion queueing and execution
- event and ABI shapes used by the runtime

The runtime can check rough ABI compatibility, but it cannot prove that the
implementation behind that ABI obeys the protocol. Developers must understand
and copy framework-specific Solidity patterns into their contracts. That makes
the bridge between server and contract loose, technical, and easy to get wrong.

The intended direction is to make the framework-specific Solidity generated.
Developers should write app business logic in normal Solidity, while ffca owns
the protocol shell that the server depends on.

## Goal

Turn ffca contract conformance from developer discipline into a deploy-time
compiler guarantee.

The user-authored Solidity should define app-specific pieces:

- state structs
- mutation structs
- optional resolution structs
- account structs and account policy
- mutation business logic

ffca should generate the protocol pieces:

- bundle and queue structs
- mutation tags
- EIP-712 typehash constants
- domain separator wiring
- `execute` dispatch loop
- force-inclusion queueing and execution
- scheduler access control
- protocol events
- server-consumable artifacts

The resulting contract should be deployable by the server, and the server should
bind itself to the exact generated artifact it deployed or loaded.

## Non-Goals

- Do not build a generic Solidity framework that adapts to arbitrary contracts.
- Do not require annotations or a separate DSL for the first version.
- Do not make the account model fully generic up front.
- Do not replace Foundry as the way developers test Solidity logic.
- Do not require app developers to hand-author ffca protocol boilerplate.

## Authoring Model

The first authoring model should be naming-convention-based Solidity.

The user writes a normal Solidity logic contract that compiles by itself and can
be tested with Foundry. That contract is not necessarily the final deployed
contract. ffca parses it, validates conventions, generates a wrapper contract,
compiles the wrapper, and deploys the generated output.

Annotations are avoided for now because the source should remain ordinary
Solidity that existing tooling understands without plugins.

## Example Target

A future `Harness` logic contract should be much smaller than today's fixture.
It should contain app state, app mutations, account policy, and business logic,
but not ffca dispatch or force-inclusion mechanics.

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {KeyType, verifySignature} from "ffca/FFCA.sol";

contract HarnessLogic {
    struct Signature {
        bytes32 account;
        uint64 keyId;
        uint8 keyType;
        bytes rawSignature;
    }

    struct Key {
        uint8 keyType;
        bytes publicKey;
    }

    struct Account {
        Key[] keys;
        mapping(uint192 => uint64) nonces;
    }

    struct State {
        mapping(bytes32 => Account) accounts;
        mapping(bytes32 => uint256) balances;
    }

    struct Initialize {
        uint8 rootKeyType;
        bytes rootPublicKey;
    }

    struct Credit {
        bytes32 account;
        uint64 keyId;
        uint256 amount;
        uint256 nonce;
    }

    struct Debit {
        bytes32 account;
        uint64 keyId;
        uint256 amount;
        uint256 nonce;
    }

    struct DebitResolution {
        uint256 newBalance;
    }

    State internal state;

    error InvalidAccount();
    error AlreadyInitialized();
    error InvalidNonce();

    function balances(bytes32 account) external view returns (uint256) {
        return state.balances[account];
    }

    function ffcaInitialize(
        Initialize calldata init,
        Signature calldata sig
    ) internal {
        bytes32 expected = keccak256(init.rootPublicKey);
        if (sig.account != expected) revert InvalidAccount();
        if (state.accounts[expected].keys.length != 0) revert AlreadyInitialized();
        state.accounts[expected].keys.push(Key(init.rootKeyType, init.rootPublicKey));
    }

    function ffcaCredit(Credit calldata credit, Signature calldata sig) internal {
        _verifySig(sig, credit.nonce);
        state.balances[sig.account] += credit.amount;
    }

    function ffcaDebit(
        Debit calldata debit,
        DebitResolution calldata resolution,
        Signature calldata sig
    ) internal {
        _verifySig(sig, debit.nonce);
        require(
            state.balances[sig.account] == resolution.newBalance + debit.amount,
            "debit: stale resolution"
        );
        state.balances[sig.account] = resolution.newBalance;
    }

    function _verifySig(Signature calldata sig, uint256 nonce) internal {
        Account storage acc = state.accounts[sig.account];
        Key storage key = acc.keys[sig.keyId];
        if (key.keyType != sig.keyType) revert InvalidAccount();

        uint192 nonceKey = uint192(nonce >> 64);
        uint64 nonceSeq = uint64(nonce);
        if (nonceSeq != acc.nonces[nonceKey]) revert InvalidNonce();
        acc.nonces[nonceKey] = nonceSeq + 1;
    }
}
```

ffca would generate and deploy a wrapper contract that inherits the logic
contract and implements the protocol surface:

```solidity
contract Harness is HarnessLogic {
    struct Bundle {
        uint8[] mutations;
        bytes[] mutationData;
        Signature[] signatures;
    }

    struct QueuedMutation {
        uint8 mutation;
        bytes mutationData;
        Signature sig;
        uint256 enqueuedBlock;
    }

    uint8 constant INITIALIZE = 0;
    uint8 constant CREDIT = 1;
    uint8 constant DEBIT = 2;

    address public immutable scheduler;
    bytes32 public immutable domainSeparator;

    QueuedMutation[] private queue;

    event ForceInclusionQueued(
        uint256 index,
        uint8 mutation,
        bytes mutationData,
        Signature sig,
        uint256 enqueuedBlock
    );

    constructor(address _scheduler) {
        scheduler = _scheduler;
        domainSeparator = _buildDomainSeparator();
    }

    function execute(Bundle[] calldata bundles, uint256[] calldata forceExecuteIndexes) external {
        if (msg.sender != scheduler) revert Unauthorized();
        _executeForceInclusions(forceExecuteIndexes);
        _executeBundles(bundles);
    }

    function enqueue(uint8 mutation, bytes calldata mutationData, Signature calldata sig) external returns (uint256) {
        uint256 index = queue.length;
        uint256 enqueuedBlock = block.number;
        queue.push(QueuedMutation(mutation, mutationData, sig, enqueuedBlock));
        emit ForceInclusionQueued(index, mutation, mutationData, sig, enqueuedBlock);
        return index;
    }

    function forceExecute(uint256 index) external {
        _forceExecute(index);
    }

    function _dispatch(uint8 tag, bytes calldata data, Signature calldata sig) internal {
        if (tag == INITIALIZE) {
            ffcaInitialize(abi.decode(data, (Initialize)), sig);
        } else if (tag == CREDIT) {
            ffcaCredit(abi.decode(data, (Credit)), sig);
        } else if (tag == DEBIT) {
            (Debit memory mutation, DebitResolution memory resolution) =
                abi.decode(data, (Debit, DebitResolution));
            ffcaDebit(mutation, resolution, sig);
        } else {
            revert UnknownTag();
        }
    }
}
```

The generated source above is illustrative. The exact memory/calldata strategy,
authorization hook, force-inclusion policy, and typehash plumbing still need to
be decided.

## Convention Rules

Initial compiler rules should be intentionally narrow.

- The user contract defines one `State` struct.
- The user contract defines one `Signature` struct.
- Mutations are discovered from internal functions named `ffca<Name>`.
- A mutation function's first parameter must be `<Name> calldata`.
- A mutation function's final parameter must be `Signature calldata`.
- A mutation with resolution uses a middle `<Name>Resolution calldata` parameter.
- A mutation without resolution has no resolution parameter.
- Mutation structs and resolution structs must be top-level structs in the logic contract.
- The deployed wrapper inherits the logic contract.
- The generated wrapper owns the public ffca protocol functions.

Example mutation signatures:

```solidity
function ffcaCredit(Credit calldata credit, Signature calldata sig) internal;

function ffcaDebit(
    Debit calldata debit,
    DebitResolution calldata resolution,
    Signature calldata sig
) internal;
```

## Components

### Compiler Pipeline

The compiler pipeline is responsible for parsing, validating, generating, and
compiling Solidity.

Inputs:

- user Solidity source
- contract name
- ffca compiler options
- Solidity compiler settings

Outputs:

- generated Solidity source
- ABI
- bytecode
- deployed bytecode
- storage layout
- source references
- compiler metadata
- runtime artifact consumed by the server

Responsibilities:

- parse Solidity AST
- validate naming conventions
- validate protocol shape
- validate mutation and resolution signatures
- generate wrapper source
- compile generated source
- emit source hashes and artifact hashes
- optionally run determinism checks

### Type Inference

Type inference turns compiler output into a typed TS surface.

Outputs should include:

- ABI as `as const`
- storage layout as `as const`
- mutation names and tags
- mutation argument types
- resolution argument types
- signature type
- a typed artifact object for `createFFCA`
- optional `.d.ts` for importing Solidity modules from TS

The server should eventually avoid hand-authored mutation params, tags, ABI, and
storage layout for generated contracts.

### Deployment Module

The server will own deployment for generated ffca contracts.

The deployment module should:

- deploy a compiled ffca artifact
- persist deployment metadata
- load an existing matching deployment
- validate deployed bytecode against the artifact
- provide the address and artifact to runtime startup
- prevent accidental reuse of stale generated artifacts

Initial deployment modes:

- `never`: require an existing matching deployment.
- `if-missing`: deploy only when no matching deployment exists.

Defer `always` and `if-changed` until redeploy and migration semantics are
clearer.

## Deployment Metadata

Server-owned deployment requires durable metadata. The exact schema can change,
but it should track enough information to bind runtime startup to a generated
artifact.

Minimum metadata fields:

```text
ffca_deployments
- id
- app_name
- chain_id
- address
- scheduler_address
- source_hash
- generated_source_hash
- bytecode_hash
- deployed_bytecode_hash
- artifact_hash
- compiler_version
- compiler_settings_json
- created_at
- updated_at
```

Open questions:

- Is this table global, per database, or per deployment schema?
- Does deployment metadata live before the per-contract schema exists?
- How does metadata interact with the existing deployment lock?
- Should metadata be recoverable from chain and local artifacts alone?

## Protocol Shape Decisions

The exact generated protocol shape must be settled before implementation.

### Resolution

Preferred first rule:

- no `<Name>Resolution` parameter means no server-side resolution
- a `<Name>Resolution` parameter means the runtime must provide resolution
- generated calldata encodes `(Mutation)` or `(Mutation, MutationResolution)`

Open questions:

- Should every mutation be allowed to have resolution?
- Should resolution structs be part of EIP-712 signing? Current direction: no.
- Should the compiler reject resolution names that do not exactly match
  `<MutationName>Resolution`?

### Account Model

The account model is the hardest boundary.

The first version should keep account policy app-owned. Generated code should
not prescribe storage shape, key lookup, permissions, or nonce semantics.

Possible approaches:

- Mutation functions verify signatures themselves.
- Generated code computes a digest and calls an app hook.
- Generated code calls a default account module supplied by ffca.

The least invasive first step is to let mutation functions own verification, as
today's `Harness` does. The generated wrapper can still own typehashes and
digest helpers later.

Open questions:

- Should generated code compute EIP-712 digests for all mutations?
- If generated code computes digests, what hook receives them?
- Should signature verification happen before dispatch or inside mutation logic?
- How are unsigned bootstrap mutations represented?
- Should ffca ship a default multi-key account module?

### Scheduler Access Control

Initial scheduler access control should be generated and simple.

Preferred first rule:

- scheduler is an immutable constructor argument
- only scheduler can call `execute`
- anyone can call `enqueue`
- anyone can call `forceExecute` after the force-inclusion delay

Open questions:

- Should scheduler rotation be app-owned or framework-owned?
- Should scheduler authority eventually live in the same account registry as
  user keys?
- Does server deployment always set scheduler to the deploying server account?

### Force Inclusion

Force inclusion should be generated because it is framework protocol logic.

Generated pieces:

- queue storage
- `enqueue`
- `forceExecute`
- `ForceInclusionQueued` event
- scheduler-assisted queue execution inside `execute`

Open force-inclusion generation questions:

- Must scheduler-assisted execution obey the public delay?
- Must the scheduler drain old queue entries before new bundle mutations?
- Are queue indexes arbitrary, or must execution follow `queueHead`?
- What happens when the queue head is invalid or expired?

### Determinism

Generated protocol code can be deterministic, but user business logic can still
read nondeterministic EVM context.

The compiler should eventually reject or warn on dangerous constructs.

Possible forbidden constructs:

- `block.timestamp`
- `block.number`
- `block.coinbase`
- `block.prevrandao`
- `tx.origin`
- external calls unless explicitly allowed
- contract balance reads if they can diverge from revm state

Open questions:

- Are determinism violations hard errors or warnings?
- Is the analysis AST-based, IR-based, bytecode-based, or layered?
- Are view helpers subject to the same restrictions as mutation functions?

## Import And Generated Type Output

Developers should be able to import ffca Solidity helpers normally:

```solidity
import {KeyType, verifySignature} from "ffca/FFCA.sol";
```

Generated outputs should live in a predictable directory, for example:

```text
generated/Harness.ffca.sol
generated/Harness.ffca.ts
generated/Harness.ffca.d.ts
generated/Harness.ffca.json
```

The generated TS module should let server code use the artifact directly:

```ts
import { harnessArtifact } from "./generated/Harness.ffca";

const ffca = await createFFCA({
  artifact: harnessArtifact,
  rpcUrl,
  database,
  account,
  sequencing,
  resolve: {
    debit: async ({ state, args }) => ({
      newBalance: await computeDebitResolution(state, args),
    }),
  },
});
```

The exact `createFFCA` shape is not settled. The important direction is that the
artifact replaces hand-copied ABI, storage layout, mutation tags, and mutation
parameter declarations.

## Implementation Plan

### 1. Write The Target Example

Define the desired final app shape in this plan and keep refining it until the
core decisions are clear.

Output:

- convention-following `HarnessLogic` example
- generated wrapper sketch
- explicit list of accepted conventions
- explicit list of open decisions

### 2. Build Deployment Metadata

Add persistent deployment metadata before changing contract generation.

Output:

- metadata table
- insert/select/update helpers
- artifact hash comparison
- tests against existing compiled fixture artifacts

### 3. Build Deployment Module

Teach ffca to deploy or load an existing compiled artifact.

Output:

- deploy `if-missing`
- startup `never`
- deployed bytecode validation
- integration with deployment lock
- runtime receives address from deployment binding

### 4. Build Type Inference From Static Artifacts

Before generating Solidity, prove the server can consume generated-style TS
artifacts.

Output:

- typed ABI export
- typed storage layout export
- typed mutation config export
- `createFFCA` path that consumes an artifact
- static artifact for `Harness`
- static artifact for `Counter`

### 5. Implement Core Compilation Pipeline

Build the parser, validator, source generator, and compiler integration.

Output:

- parse convention-following Solidity
- discover mutation functions
- discover mutation and resolution structs
- generate wrapper source
- compile generated wrapper
- emit artifacts matching the static artifact shape

### 6. Port Harness

Replace the hand-written protocol-heavy `Harness.sol` with a small logic
contract plus generated wrapper.

Output:

- smaller logic contract
- generated wrapper committed or generated in tests
- existing runtime tests pass
- force-inclusion behavior remains covered

### 7. Port Counter

Move `Counter` through the same path to prove the compiler is not only tailored
to `Harness`.

Output:

- small counter logic contract
- generated wrapper
- existing counter tests pass

### 8. Evaluate Order-Book Migration

Only after fixtures prove the pipeline, evaluate moving the app contract to the
generated path.

Output:

- migration notes
- missing compiler features
- account model gaps
- deployment workflow gaps

## Success Criteria

- Developers no longer hand-author `execute`, `enqueue`, or `forceExecute`.
- Developers no longer copy mutation tags, ABI fragments, or storage layout into
  server config.
- The server deploys or loads a contract using persisted artifact metadata.
- Runtime startup can verify that the deployed bytecode matches the artifact it
  is using.
- `Harness` shrinks substantially while keeping its account model and business
  behavior.
- Existing Foundry-based Solidity testing remains viable for app logic.
- Existing ffca runtime tests continue to exercise real generated contracts.

## Open Decisions

- Exact naming convention for mutation functions.
- Whether mutation tags are source-order-based or explicitly declared.
- Whether generated code computes EIP-712 digests immediately or later.
- Whether account validation stays inside mutation functions for MVP.
- How unsigned bootstrap mutations are represented.
- Whether force-inclusion queue execution must be FIFO by construction.
- Whether scheduler-assisted queue execution must obey the public delay.
- Whether deployment metadata is global or per-deployment-schema.
- How `.sol` imports map to generated `.d.ts` and `.ts` outputs.
- Which determinism checks are MVP blockers.
