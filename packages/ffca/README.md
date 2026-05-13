# FFCA

Full stack framework for building crypto apps.

- **Custom sequencing**. Applications define their transaction ordering (fifo, frequent batch, or any rule it chooses).
- **Sub-block confirmations**. Applications can issue responses in milliseconds, before transactions finalize onchain.
- **Modern signature primitives**. EIP-712 plus native P-256, WebAuthn-P256, and secp256k1 verification; apps define their own account policy.
- **Minimal dependencies**. No external relayers, sequencers, or builder auctions between users and the application. The application has end-to-end control over what users experience.
- **Local first**. Build rapidly with a powerful local development loop.

> This project is under active development. Not ready for production use.

## Concepts

### State

### Mutations

### Accounts and Signatures

ffca requires mutations to be signed with EIP-712 typed data. The runtime builds the digest from the configured domain, mutation name, and mutation arguments; clients do not supply the digest directly.

ffca supports three signature algorithms:

- P-256
- WebAuthn-P256
- secp256k1

The framework owns the EIP-712 digest construction, calldata encoding, and native signature verification primitives for those algorithms. Apps own account policy.

`Account` and `Signature` structs are app-defined. The `Signature` struct must include `keyType: uint8` and `rawSignature: bytes`, declared through `FFCAConfig.signature.params`. Apps add whatever other fields their contract expects, such as `account`, `keyId`, nonce metadata, or permission scope.

Account registry shape, key lookup, nonce policy, expiry/deadline checks, bootstrap mutations, and permissions are left up to users to implement in their app and contract.

### Sequencing

## Getting started

## Examples

- **`order-book`**.
- **`token`**.

## Tradeoffs

## Trust assumptions

### Inclusion

Transaction submission is gated to a single scheduler address. It's what makes the custom sequencing and fast confirmations possible, but it also gives the scheduler the power to deny, or censor, a user of the application.

Users can always bypass the scheduler and interact directly with the protocol. See `force-inclusion` to read more.

### Onchain divergence



## Failure modes

### Reorgs

### Force inclusion

## API reference
