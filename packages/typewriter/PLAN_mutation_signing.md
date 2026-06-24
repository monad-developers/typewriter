# Mutation Signing Plan

Working notes for redesigning typewriter mutation signing from first principles.

## Problem

The current mutation signing path makes app developers duplicate too much
schema-specific code. In `apps/token/src/app.ts`, each signed mutation needs its
own EIP-712 `types`, typed params, signing helper, and raw signature packing.
The frontend duplicates the same shape again.

This is the wrong developer boundary. Apps should define state and mutations;
typewriter should own as much signing, replay protection, signature packing, and
verification plumbing as possible.

The goal is to minimize client signing code, ideally to zero app-specific code.

## Current Constraint

Strict per-mutation EIP-712 requires the signer to know the exact typed schema:

```ts
{
  domain,
  types: {
    Transfer: [
      { name: "from", type: "address" },
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
      { name: "nonce", type: "uint256" },
      { name: "deadline", type: "uint256" },
    ],
  },
  primaryType: "Transfer",
  message,
}
```

That is useful when a wallet can display structured signing intent to a human.
It is much less useful when signing is performed by client-held session keys or
passkeys:

- passkeys sign a challenge and do not display EIP-712 fields
- session keys are already delegated by a prior authorization step
- the app UI, not the wallet prompt, is often the meaningful user-facing intent
- per-mutation EIP-712 forces schema boilerplate into every app and client

EIP-712 should be treated as one possible presentation/signing format, not as
the core typewriter authorization model.

## First-Principles Requirement

A mutation signature should prove:

```text
This account/key authorized this exact mutation payload for this typewriter app,
on this chain/deployment, at this nonce, before this deadline.
```

The signer does not necessarily need to understand the app-specific mutation
schema. The framework and contract still need schema to encode, decode, store,
and execute the mutation, but the signer can authorize a fixed-size commitment
to the encoded mutation data.

## Generic Payload Split

Separate execution data from auth data.

Execution payload:

```ts
type MutationExecution = {
  mutation: number; // canonical tag, e.g. Transfer = 0
  mutationData: Hex; // ABI-encoded app-specific params
};
```

Auth payload:

```ts
type MutationAuth = {
  account: Hex;
  keyId: bigint;
  nonce: bigint;
  deadline: bigint;
  keyType: number;
  rawSignature: Hex;
};
```

The signed digest commits to both:

```ts
digest = hashMutation({
  chainId,
  verifyingContract,
  account,
  keyId,
  nonce,
  deadline,
  mutation,
  mutationDataHash: keccak256(mutationData),
});
```

`name` remains useful at the TypeScript/API layer, but the canonical signed
value should be the mutation tag. Names are developer ergonomics; tags are the
stable wire/onchain representation.

## Candidate Digest

The native typewriter digest can be a fixed-schema ABI hash:

```solidity
bytes32 constant FFCA_MUTATION_TYPEHASH = keccak256(
    "FFCAMutation(uint256 chainId,address verifyingContract,bytes32 account,uint64 keyId,uint64 nonce,uint64 deadline,uint8 mutation,bytes32 mutationDataHash)"
);

function hashMutationAuth(
    bytes32 account,
    uint64 keyId,
    uint64 nonce,
    uint64 deadline,
    uint8 mutation,
    bytes32 mutationDataHash
) internal view returns (bytes32) {
    return keccak256(
        abi.encode(
            FFCA_MUTATION_TYPEHASH,
            block.chainid,
            address(this),
            account,
            keyId,
            nonce,
            deadline,
            mutation,
            mutationDataHash
        )
    );
}
```

This can still be wrapped in EIP-712 if useful, but it does not require an
app-specific EIP-712 type per mutation.

For passkeys, this digest becomes the WebAuthn challenge. For session keys, this
is the digest signed by the delegated key.

## Most Generic Schema

The most generic execution schema is close to:

```ts
{
  name: string;
  mutationData: Hex;
}
```

For canonical signing, prefer:

```ts
{
  mutation: number;
  mutationDataHash: Hex;
}
```

`name` can be accepted by developer APIs and resolved to `mutation`. The signed
payload should avoid mutable presentation names unless there is a strong reason
to make names part of the protocol.

## Session Key Model

The likely long-term model is:

1. The user rarely signs a high-level session authorization.
2. The authorized session key/passkey signs generic typewriter mutation digests.
3. The app UI is responsible for displaying intent at mutation time.
4. The contract verifies nonce, deadline, key status, permissions, and signature.

Session authorization may still use EIP-712 because it is infrequent and
wallet-facing:

```ts
type AuthorizeSession = {
  account: Hex;
  sessionPublicKey: Hex;
  keyType: number;
  expiresAt: bigint;
  permissionsHash: Hex;
};
```

Per-mutation signing should not require per-mutation EIP-712 schemas.

## Framework Boundary

To get close to zero app-specific signing code, typewriter likely needs to own more of
the account/signature boundary:

- account identity format
- key IDs and key lookup
- key type dispatch
- nonce policy
- deadline checks
- session key validity
- raw signature encoding
- mutation auth digest construction
- onchain signature verification helper
- client signing helper/SDK

Apps should own:

- mutation params and business logic
- account permissions that are truly app-specific
- optional policy checks beyond the framework baseline

This is a more prescriptive framework boundary than the current design, but it
matches typewriter's goal of making conformance the API.

## Contract Shape Direction

Today apps implement `dispatch(uint8 mutation, bytes mutationData, bytes
signatureData)` and decode/verify signatures per mutation.

A more framework-owned shape would be:

```solidity
function dispatchAuthenticated(
    bytes32 account,
    uint8 mutation,
    bytes memory mutationData
) internal virtual;
```

typewriter would handle before dispatch:

- decode `MutationAuth`
- compute `keccak256(mutationData)`
- compute the generic typewriter digest
- load the account key
- check nonce/deadline/session validity
- verify the signature
- increment or consume the nonce

The app would only decode `mutationData` and apply business logic.

## Near-Term Incremental Options

### 1. FFCA EIP-712 Helper

Add a framework helper that derives EIP-712 types from parsed mutation metadata
and packs signatures. This removes duplicated `MINT_TYPES`, `TRANSFER_TYPES`,
and per-mutation signing helpers without changing the protocol.

This is useful but does not solve the deeper issue: EIP-712 remains the signing
model and still requires mutation schema to reach the signer.

### 2. Metadata-Driven Browser SDK

Expose mutation metadata and domain information from the server so a client SDK
can sign and submit without app-authored schema code.

This improves DX while preserving the current model. It should include a schema
or artifact hash so clients can pin what they are signing.

### 3. Native Generic Digest

Introduce the fixed typewriter mutation digest and signature envelope. This is the
largest conceptual improvement and the likely target architecture.

This can coexist with EIP-712 helpers during migration.

### 4. Framework-Owned Accounts

Move nonce/deadline/key/session verification into typewriter contracts and TS helpers.
This is the step that makes signing code disappear for app developers.

## Open Decisions

- Should `account` be `bytes32`, `address`, or app-defined?
- Should `keyId` be fixed-width, and should it be part of every mutation auth?
- Should nonces be per account, per key, or app-defined?
- Should deadlines be mandatory for every signed mutation?
- Should `mutation` tags be stable across contract upgrades, and how are they
  pinned?
- Should the generic digest include a literal version string, a typehash, or
  both?
- Should typewriter keep EIP-712 as an optional wrapper around the generic digest?
- How should session permissions be represented: app-defined hook,
  `permissionsHash`, bitsets, mutation allowlists, or something else?
- Where should account/key/session state live in the storage layout?
- How much of this can be introduced without breaking the current dispatch
  surface?

## Working Recommendation

Do not optimize the long-term design around strict per-mutation EIP-712.

Use EIP-712 where it is actually valuable: rare wallet-facing authorizations,
especially session key creation. For routine mutations, use a fixed typewriter-native
digest that signs a commitment to canonical mutation bytes.

The north star is:

```ts
await typewriter.execute({
  name: "Transfer",
  params: { to, amount },
});
```

with typewriter responsible for:

- resolving `name` to a mutation tag
- ABI-encoding params into `mutationData`
- computing the generic auth digest
- asking the active key/passkey/session signer to sign the digest
- packing the signature envelope
- submitting the mutation

The signer only sees a generic bytes32 challenge. The app developer writes no
mutation-specific signing code.
