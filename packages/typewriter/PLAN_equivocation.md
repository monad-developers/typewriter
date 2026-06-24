# Equivocation Plan

Working notes for typewriter's first equivocation-protection design.

## Problem

typewriter servers can issue optimistic responses before settlement. A malicious or
buggy server could tell a user that one mutation was accepted, then settle a
different mutation onchain.

Censorship is different: a server can refuse to accept or submit a mutation.
Receipts do not solve censorship. They make accepted-history lies attributable
and independently provable.

## Minimal Receipt

The smallest useful primitive is a server-signed accepted receipt:

```ts
type AcceptedReceipt = {
  version: 1;
  appId: string;
  chainId: number;
  contract: Address;
  serverId: string;

  bundleId: bigint;
  bundlePosition: number;
  mutationHash: Hex;

  issuedAt: number;
};

type SignedAcceptedReceipt = {
  receipt: AcceptedReceipt;
  signature: Hex;
};
```

The receipt says:

```text
The server accepted mutation M at bundle B position P.
```

`mutationHash` commits to the exact submitted mutation, including the user's
signature. The user can recompute it locally.

## Basic Client Protection

The client stores every signed accepted receipt it receives. It immediately
checks:

- the server signature is valid
- `mutationHash` matches the submitted mutation
- `appId`, `chainId`, `contract`, and `serverId` match the expected app
- `bundleId` and `bundlePosition` are present

Then the client waits for settlement and compares the receipt to chain reality:

```text
receipt says: bundle B position P settled mutation M
chain says:   bundle B position P settled mutation M'
```

If `M !== M'`, the server lied. The proof is the signed receipt plus the
onchain settlement evidence.

The minimum client detector tracks only the current user's receipts. It does not
need to monitor the whole server.

```ts
type TrackedReceipt = {
  mutation: SubmittedMutation;
  signedReceipt: SignedAcceptedReceipt;
  status: "accepted" | "verified" | "mismatch" | "expired";
};
```

Detection loop:

```ts
for (const item of trackedReceipts) {
  if (item.status !== "accepted") continue;

  const settled = await getSettledMutation(
    item.signedReceipt.receipt.bundleId,
    item.signedReceipt.receipt.bundlePosition,
  );

  if (settled === undefined) continue;

  if (settled.mutationHash === item.signedReceipt.receipt.mutationHash) {
    item.status = "verified";
  } else {
    item.status = "mismatch";
    warnUser(buildProof(item, settled));
  }
}
```

## Proof Object

A portable social proof can be small:

```ts
type SettlementEquivocationProof = {
  kind: "settled-slot-mismatch";
  signedReceipt: SignedAcceptedReceipt;
  submittedMutation: SubmittedMutation;
  observed: {
    transactionHash: Hex;
    bundleId: bigint;
    bundlePosition: number;
    mutationHash: Hex;
  };
};
```

This proves:

```text
The server signed that mutation M was accepted at slot (B, P), but onchain
settlement for slot (B, P) contains mutation M'.
```

## Watchers

Watchers should be easy to build, but the first useful watcher can be narrow:
it accepts receipts from clients, validates them, and compares them to chain
settlement.

Minimum watcher responsibilities:

- accept `SignedAcceptedReceipt` reports from clients
- verify server signatures
- verify receipt app identity fields
- store a working set of reported receipts
- observe settled mutation hashes by `(bundleId, bundlePosition)`
- emit a loud alert when a reported receipt conflicts with settlement

The watcher does not need app-specific state. It only needs the receipt hash
rules, server public key, and a way to map settled bundle slots to mutation
hashes.

Suggested public surfaces for apps that want watcher support:

```http
GET /typewriter/receipts/:bundleId/:bundlePosition
POST /typewriter/receipts/report
GET /typewriter/settlement/:bundleId/:bundlePosition
```

These are app-owned HTTP routes. typewriter should provide the types, hashing,
signing, verification helpers, and watcher utilities.

## Settlement Observability

To compare receipts against chain settlement, clients and watchers need to learn
the settled mutation hash for a bundle slot.

Preferred contract event:

```solidity
event TypewriterMutationSettled(
    uint256 indexed bundleId,
    uint256 indexed bundlePosition,
    bytes32 mutationHash
);
```

If the contract does not emit per-mutation settlement events, a detector can
decode submitted calldata, but that makes watcher construction harder.

## Optional Receipt Chain

An optional upgrade is to add a global receipt-chain link:

```ts
prevAcceptedReceiptHash: Hex;
```

Then each receipt says:

```text
The server accepted mutation M at bundle B position P after previous accepted
receipt H.
```

This makes the accepted log globally auditable and lets watchers detect receipt
history forks. It is not required for the minimum client-side settlement
mismatch proof.

If added, `prevAcceptedReceiptHash` should mean the hash of the immediately
preceding accepted receipt in the server's global accepted-mutation log, not the
previous receipt for an individual user.

## Deferred Onchain Proof

The likely onchain proof is receipt-vs-settlement conflict, not
receipt-vs-receipt conflict.

To prove this onchain, the contract must store a settlement commitment. Events
alone are not enough because contracts cannot inspect past logs.

Two possible storage shapes:

```solidity
mapping(uint256 bundleId => mapping(uint256 position => bytes32 mutationHash))
    public settledMutationHash;
```

or:

```solidity
mapping(uint256 bundleId => bytes32 mutationRoot) public settledBundleRoot;
```

Then anyone can submit the signed receipt plus evidence of the actual settled
mutation. The contract verifies the receipt signature, verifies the settled slot
or Merkle proof, checks that the hashes differ, and emits an event.

Example event:

```solidity
event SequencerSettlementEquivocationProven(
    address indexed sequencer,
    uint256 indexed bundleId,
    uint256 indexed bundlePosition,
    bytes32 receiptHash,
    bytes32 promisedMutationHash,
    bytes32 settledMutationHash
);
```

This does not need to slash or revert anything. It is a canonical public
attestation that the sequencer signed one claim and settled another.

## Trust Statement

Receipts do not make the server honest. They change the failure mode.

Without receipts:

```text
The server can lie privately, and users have little portable evidence.
```

With receipts:

```text
The server can still censor, delay, crash, or go offline. But if it signs that a
mutation was accepted at a bundle slot and later settles a different mutation at
that slot, the user has compact evidence of equivocation.
```

## MVP

1. Define `AcceptedReceipt` and `SignedAcceptedReceipt`.
2. Define deterministic `hashMutation` and `hashReceipt` helpers.
3. Add server receipt signing to accepted mutations.
4. Return signed receipts from `execute` responses.
5. Emit or expose settled mutation hashes by `(bundleId, bundlePosition)`.
6. Add client-side receipt verification and settlement comparison helpers.
7. Add a minimal watcher helper that accepts receipts and alerts on settlement
   mismatch.
