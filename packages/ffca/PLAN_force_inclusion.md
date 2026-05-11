# Force Inclusion Plan

Working notes for adding force inclusion to ffca contracts and runtime.

## Goal

Force inclusion gives users a censorship escape hatch. If the scheduler refuses
to accept or submit a signed mutation, the user can put the mutation onchain and
eventually execute it without scheduler cooperation.

This is distinct from equivocation protection. Force inclusion addresses
censorship and liveness. Receipts and settlement checks address lying about what
was accepted or settled.

## Contract Shape

The current Counter fixture is the first implementation target. The intended
shape is a generic queue of mutation payloads:

```solidity
struct QueuedMutation {
    uint8 mutation;
    bytes mutationData;
    Signature sig;
    uint256 enqueuedBlock;
}
```

The queue stores the same mutation tag, encoded mutation data, and signature
shape that scheduler-submitted bundles use.

## Execution Paths

There are three relevant paths:

```text
enqueue
  User stores a signed mutation onchain.

forceExecute
  Anyone executes queued mutations after the force-inclusion delay.

execute
  Scheduler submits normal bundles and may also pull queued mutations into the
  same call.
```

For now, most validation lives in the execution step, not enqueue. That keeps
enqueue minimal, but it introduces griefing and invalid-head questions that need
to be resolved before production use.

## Ordered Execution

Queued mutations must execute in order. This applies to both direct public
`forceExecute` and scheduler-assisted execution through `execute`.

Open implementation options:

```solidity
uint256 public queueHead;
```

Then require every executed queue index to equal `queueHead`, incrementing the
head after each successful execution.

If the scheduler API accepts explicit indexes, those indexes should act as a
caller assertion, not as arbitrary choice:

```solidity
if (forceExecuteIndexes[i] != queueHead) revert InvalidQueueIndex();
```

That preserves an index-based API while enforcing FIFO execution.

## Delay Semantics

Public force execution should require a delay:

```solidity
if (block.number < queued.enqueuedBlock + FORCE_INCLUSION_DELAY) revert TooEarly();
```

Open decision: should scheduler-assisted queue execution inside `execute` obey
the same delay?

Possible answers:

- Scheduler may include queued mutations immediately. This lets the scheduler
  clean up the queue quickly and settle user intent through the normal path.
- Scheduler must also wait the delay. This gives a single rule for all queued
  execution, but makes the scheduler less able to help.

The Counter fixture can choose the simplest behavior for tests, but production
docs should make the rule explicit.

## Mandatory Draining

Production contracts should make it hard for the scheduler to leave old
force-inclusion entries pending forever.

Desired future invariant:

```text
When the scheduler calls execute, it must execute all queued mutations older
than X blocks before executing new bundled mutations.
```

This is not implemented yet. It likely wants a stronger queue/indexing data
structure plus an immutable age threshold.

## Invalid Queue Entries

Because enqueue currently does little or no validation, the head queued mutation
may be invalid by the time execution is attempted.

Failure cases:

- unknown mutation tag
- invalid signature
- expired mutation, if deadlines are part of the mutation shape
- nonce conflict
- insufficient balance or app-specific precondition failure

Open policy choices:

- Revert and block the queue until the invalid head is resolved.
- Allow invalid expired heads to be skipped or marked failed.
- Validate more at enqueue to make invalid heads harder to create.
- Reserve nonce or otherwise commit at enqueue.

For now, the Counter fixture can keep revert-on-invalid behavior. That is simple
and useful for tests, but not sufficient as a production policy.

## ABI And Runtime

The current force-inclusion ABI is:

```ts
execute(bundles, forceExecuteIndexes)
```

The ABI, runtime `encodeFunctionData`, simulation, access-list creation, gas
estimation, and tests must all agree on the final shape.

## Other Implementations

After Counter, force inclusion needs to be applied consistently to:

- Harness fixture
- order-book contracts
- any other ffca-conforming examples

Each implementation should preserve the same high-level semantics even if its
account model, nonce model, and mutation set differ.

## Client And SDK Surface

Clients need helpers for:

- encoding a mutation for enqueue
- submitting `enqueue`
- discovering or tracking the queued mutation index
- calling `forceExecute`
- watching whether the scheduler included the queued mutation first

If there are no enqueue/force-execute events, index discovery must come from
another explicit surface such as a return value, view function, receipt, or
state watcher.

## Watch Implementation

The watch loop should eventually detect force-inclusion activity and reconcile
it with normal scheduler submissions.

Things to observe:

- queued mutations added onchain
- queued mutations executed directly via `forceExecute`
- queued mutations pulled into scheduler `execute`
- queued mutations that remain pending past the expected threshold

The watcher should be able to answer:

```text
Was this user's force-included mutation queued?
Was it executed?
Was it executed directly or by the scheduler?
Did the scheduler leave old entries pending?
```

Without events, this likely requires decoding calldata and/or reading queue
state. Events would make the watcher simpler, but the current direction is to
avoid events in the Counter fixture for now.

## Docs

Documentation should explain force inclusion separately from equivocation:

- Force inclusion mitigates censorship and scheduler downtime.
- It does not prove the scheduler lied.
- It is slower than the optimistic server path.
- It gives users an onchain fallback when the server refuses to cooperate.

Docs should cover:

- normal lifecycle
- enqueue lifecycle
- force execution delay
- scheduler-assisted queue execution
- queue ordering
- failure cases and trust assumptions

## Work List

1. Update the ffca ABI/contract shape for force inclusion.
2. Update runtime submission to pass the new `execute` arguments.
3. Update Counter implementation.
4. Update Harness implementation.
5. Update order-book implementation.
6. Add client/SDK helpers for enqueue and force execute.
7. Add watcher outline and then implementation for detecting force includes.
8. Write docs for trust assumptions and user flow.
9. Add e2e tests for enqueue, ordered force execution, scheduler-assisted queue
   execution, replay prevention, nonce conflicts, and watcher detection.
