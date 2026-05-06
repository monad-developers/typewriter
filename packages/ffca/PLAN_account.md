# Account model

Working notes for the ffca account/signature surface. Direction is native
primitives — ffca ships the cryptography (secp256k1, P-256, WebAuthn-P256)
and the EIP-712 digest construction; apps supply state-side policy (key
registry shape, nonces, permissions, expiry, the `Initialize`-style
bootstrap mutation).

The `Account` and `Signature` structs themselves are app-defined. The
`Signature` struct must include `keyType: uint8` and `rawSignature: bytes`
(declared via `FFCAConfig.signature.params`). Apps add whatever else their
contract expects — `account`, `keyId`, etc.

## Status

- ✅ `signature.params` field on `FFCAConfig` (required, declares the wire
  shape). No validation yet that `keyType` and `rawSignature` are present —
  that comes later.
- ⏳ Encoding the wire signature into `bundle.signatures[]` using
  `signature.params` (next step).
- ⏳ Authorize hook — single seam where ffca passes the digest, signature,
  args, and state to the app. Open question: one hook (app calls ffca's
  crypto) vs. two hooks (app supplies key, ffca verifies).
- ⏳ Native sig verification primitives (P-256, WebAuthn-P256, secp256k1).
  Extracted from `apps/order-book-backend/src/signature.ts:135-260`.
- ⏳ EIP-712 digest construction at the seam — ffca builds, never accepts a
  client-supplied digest.

## Open decisions

### Verify in TS vs. delegate to a contract view function

Status: **future**, not blocking the current work.

Instead of ffca shipping native verifiers and an authorize hook, the
contract could expose a `view` function that does the entire authorization
check (key lookup, permission, nonce, expiry, signature recovery) and
ffca pre-flights every mutation via `eth_call` against it.

**For:**
- Single source of truth. The contract's `execute()` already does this work
  on-chain; a view function reuses the same Solidity. No TS reimplementation
  to keep in sync. Order-book's `apps/order-book-backend/src/signature.ts`
  is exactly the kind of mirror that rots — this kills the mirror.
- Apps that change auth semantics change Solidity only. ffca and the TS
  surface are stable.
- Matches the "blockchains are the database" belief — the contract is the
  spec for "is this signed correctly?", not just for "what does this
  mutation do?"

**Against:**
- Latency. `eth_call` per `execute()` adds RPC round-trip time on the hot
  path. Anvil locally is ~1 ms, real RPCs are 20–100 ms. Cuts against
  ffca's performance ceiling.
- RPC capacity is now in the auth path — outage means no mutations can
  even queue (today they'd queue and fail at submit).
- Loses structured rejection reasons. `eth_call` reverts give a string at
  best; `KeyExpired` vs `InvalidNonce` becomes harder to surface to the
  client.
- Requires apps to expose a verify view function in a prescribed shape.
  ffca becomes more opinionated about the contract surface.

**Mitigation: batched verify.** A contract-side `verifyBatch(...)` view
called once per bundle window (50 ms — already paid) instead of per
mutation. Same wall time as today, no extra round-trips. Needs a contract-
level surface but recovers most of the latency loss.

**When to revisit:** after the in-TS authorize hook lands and the order-
book port is on it. At that point we'll have a working baseline to
measure latency against, and the cost of *removing* the TS verifier (vs.
the cost of *adding* the eth_call) becomes the real comparison.

### One hook vs. two

Status: open, blocks the authorize-hook step.

**One hook** — app does everything, calls ffca's exported crypto helpers
internally:
```ts
authorize: ({ digest, signature, args, state }) => {
  const key = state.accounts[signature.account].keys[signature.keyId];
  ffca.verifyP256(digest, key.publicKey, signature.rawSignature);  // throws
}
```

**Two hooks** — app answers state questions, ffca runs crypto:
```ts
resolveKey: ({ signature, args, state }) => ({ publicKey, keyType, rpId? }),
postVerify: ({ signature, args, state }) => { /* nonce bump, etc. */ },
```

Two-hook keeps the app from touching crypto at all — closer to the "let
developers think less" goal. One-hook is smaller surface area and gives
the app more control (e.g. can short-circuit verification on bootstrap
mutations without a separate "skip" signal).

The naming pushback earlier was on `resolveKey` specifically, not the
two-hook concept. Worth re-trying with a clearer name (`getSigner`?
`lookupKey`?) before deciding.

## Next steps (sequenced)

1. ✅ Add `signature.params` to `FFCAConfig`.
2. **Encode wire signature into `bundle.signatures[]`** using `signature.params`.
   `SubmittedMutation.signature` becomes structured (was `Hex.Hex`).
3. Authorize hook (one or two — decide first).
4. Move EIP-712 digest construction into the runtime, pass it to the hook.
5. Ship native crypto primitives ffca exports (or, if two-hook, ffca calls
   internally).
6. Validate `signature.params` includes `keyType` + `rawSignature` at
   `createFFCA` time.
7. Port `apps/order-book-backend` onto the new seam.
