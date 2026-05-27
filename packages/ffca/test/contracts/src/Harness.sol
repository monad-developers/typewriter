// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {EIP712_DOMAIN_TYPEHASH} from "ffca/FFCA.sol";
import {KeyType, verifySignature, verifySignatureMemory} from "ffca/Account.sol";

struct Signature {
    bytes32 account;
    uint64 keyId;
    uint8 keyType;
    bytes rawSignature;
}

struct Batch {
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

struct Key {
    uint8 keyType;
    bytes publicKey;
}

struct Account {
    Key[] keys;
    // Parallel nonces: high 192 bits select a queue; low 64 bits are the
    // sequence within that queue. Same shape the order-book uses so multi-
    // key e2e tests exercise realistic concurrency.
    mapping(uint192 => uint64) nonces;
}

struct State {
    mapping(bytes32 => Account) accounts;
    mapping(bytes32 => uint256) balances;
}

struct InitializeMutation {
    uint8 rootKeyType;
    bytes rootPublicKey;
}

struct AuthorizeMutation {
    bytes32 account;
    uint64 keyId;
    uint8 keyType;
    bytes publicKey;
    uint256 nonce;
}

struct CreditMutation {
    bytes32 account;
    uint64 keyId;
    uint256 amount;
    uint256 nonce;
}

struct DebitMutation {
    bytes32 account;
    uint64 keyId;
    uint256 amount;
    uint256 nonce;
}

struct DebitResolution {
    uint256 newBalance;
}

struct AssertMutation {
    bytes32 account;
    uint64 keyId;
    uint256 expected;
    uint256 nonce;
}

// .0001 downtime / month / (.4 s / block) * 2,629,800 s / month
uint256 constant FORCE_INCLUSION_DELAY = 658;

/// Multi-key fixture for ffca's submit path. Accounts are 32-byte ids; each
/// holds a list of keys (any of the three KeyTypes from Account.sol).
/// Signatures carry (account, keyId, keyType, rawSignature). All mutations
/// except `initialize` are signed; their EIP-712 digest binds (account,
/// keyId, nonce, …) so a stale or replayed signature can't land.
///
/// Tags:
///   INITIALIZE (0): args = (rootKeyType, rootPublicKey). No signature
///                    needed — account is derived as keccak256(rootPublicKey)
///                    so the publicKey itself authenticates the bootstrap.
///   AUTHORIZE  (1): args = (account, keyId, keyType, publicKey, nonce).
///                    Signed by an existing key on `account`.
///   CREDIT     (2): args = (account, keyId, amount, nonce). Signed.
///   DEBIT      (3): args = (account, keyId, amount, nonce); resolution =
///                    (newBalance). Signed. Reverts if resolution doesn't
///                    match pre-state.
///   ASSERT     (4): args = (account, keyId, expected, nonce). Signed.
///                    Read-only — reverts if balance != expected.
contract Harness {
    bytes32 constant INITIALIZE_TYPEHASH = keccak256("initialize(uint8 rootKeyType,bytes rootPublicKey)");
    bytes32 constant AUTHORIZE_TYPEHASH =
        keccak256("authorize(bytes32 account,uint64 keyId,uint8 keyType,bytes publicKey,uint256 nonce)");
    bytes32 constant CREDIT_TYPEHASH = keccak256("credit(bytes32 account,uint64 keyId,uint256 amount,uint256 nonce)");
    bytes32 constant DEBIT_TYPEHASH = keccak256("debit(bytes32 account,uint64 keyId,uint256 amount,uint256 nonce)");
    bytes32 constant ASSERT_TYPEHASH = keccak256("assert(bytes32 account,uint64 keyId,uint256 expected,uint256 nonce)");

    State internal state;

    address immutable SCHEDULER;
    bytes32 immutable DOMAIN_SEPARATOR;

    QueuedMutation[] private queue;

    enum Mutation {
        Initialize,
        Authorize,
        Credit, 
        Debit,
        Assert
    }

    error Unauthorized();
    error InvalidAccount();
    error AlreadyInitialized();
    error InvalidNonce();
    error UnknownTag();
    error TooEarly();
    error AlreadyExecuted();

    event ForceInclusionQueued(uint256 index, uint8 mutation, bytes mutationData, Signature sig, uint256 enqueuedBlock);

    constructor() {
        SCHEDULER = msg.sender;
        DOMAIN_SEPARATOR = keccak256(
            abi.encode(
                EIP712_DOMAIN_TYPEHASH, keccak256(bytes("Harness")), keccak256(bytes("1")), block.chainid, address(this)
            )
        );
    }

    function execute(Batch[] calldata batches, uint256[] calldata forceExecuteIndexes) external {
        if (msg.sender != SCHEDULER) revert Unauthorized();

        for (uint256 i; i < forceExecuteIndexes.length; i++) {
            uint256 index = forceExecuteIndexes[i];
            QueuedMutation storage queued = queue[index];

            if (queued.enqueuedBlock == 0) revert AlreadyExecuted();

            uint8 mutation = queued.mutation;
            bytes memory mutationData = queued.mutationData;
            Signature memory sig = queued.sig;

            delete queue[index];

            _applyMemory(Mutation(mutation), mutationData, sig);
        }

        for (uint256 b; b < batches.length; b++) {
            Batch calldata batch = batches[b];
            for (uint256 i; i < batch.mutations.length; i++) {
                _apply(Mutation(batch.mutations[i]), batch.mutationData[i], batch.signatures[i]);
            }
        }
    }

    function enqueue(uint8 mutation, bytes calldata mutationData, Signature calldata sig) external returns (uint256) {
        uint256 index = queue.length;
        uint256 enqueuedBlock = block.number;
        queue.push(
            QueuedMutation({mutation: mutation, mutationData: mutationData, sig: sig, enqueuedBlock: enqueuedBlock})
        );
        emit ForceInclusionQueued(index, mutation, mutationData, sig, enqueuedBlock);
        return index;
    }

    function forceExecute(uint256 index) external {
        QueuedMutation storage queued = queue[index];

        if (queued.enqueuedBlock == 0) revert AlreadyExecuted();
        if (block.number < queued.enqueuedBlock + FORCE_INCLUSION_DELAY) revert TooEarly();

        Mutation mutation = Mutation(queued.mutation);
        bytes memory mutationData = queued.mutationData;
        Signature memory sig = queued.sig;

        delete queue[index];

        _applyMemory(mutation, mutationData, sig);
    }

    function _digest(bytes32 structHash) internal view returns (bytes32) {
        return keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR, structHash));
    }

    function _verifySig(bytes32 structHash, uint256 nonce, Signature calldata sig) internal {
        Account storage acc = state.accounts[sig.account];
        Key storage key = acc.keys[sig.keyId];
        if (key.keyType != sig.keyType) revert InvalidAccount();

        bytes32 digest = _digest(structHash);
        verifySignature(KeyType(sig.keyType), digest, key.publicKey, sig.rawSignature);

        uint192 nonceKey = uint192(nonce >> 64);
        uint64 nonceSeq = uint64(nonce);
        if (nonceSeq != acc.nonces[nonceKey]) revert InvalidNonce();
        acc.nonces[nonceKey] = nonceSeq + 1;
    }

    function _verifySigMemory(bytes32 structHash, uint256 nonce, Signature memory sig) internal {
        Account storage acc = state.accounts[sig.account];
        Key storage key = acc.keys[sig.keyId];
        if (key.keyType != sig.keyType) revert InvalidAccount();

        bytes32 digest = _digest(structHash);
        verifySignatureMemory(KeyType(sig.keyType), digest, key.publicKey, sig.rawSignature);

        uint192 nonceKey = uint192(nonce >> 64);
        uint64 nonceSeq = uint64(nonce);
        if (nonceSeq != acc.nonces[nonceKey]) revert InvalidNonce();
        acc.nonces[nonceKey] = nonceSeq + 1;
    }

    function _apply(Mutation mutation, bytes calldata data, Signature calldata sig) internal {
        if (mutation == Mutation.Initialize) {
            InitializeMutation memory init = abi.decode(data, (InitializeMutation));
            bytes32 expected = keccak256(init.rootPublicKey);
            if (sig.account != expected) revert InvalidAccount();
            if (state.accounts[expected].keys.length != 0) revert AlreadyInitialized();
            state.accounts[expected].keys.push(Key(init.rootKeyType, init.rootPublicKey));
        } else if (mutation == Mutation.Authorize) {
            AuthorizeMutation memory auth = abi.decode(data, (AuthorizeMutation));
            bytes32 structHash = keccak256(
                abi.encode(
                    AUTHORIZE_TYPEHASH, auth.account, auth.keyId, auth.keyType, keccak256(auth.publicKey), auth.nonce
                )
            );
            _verifySig(structHash, auth.nonce, sig);
            state.accounts[sig.account].keys.push(Key(auth.keyType, auth.publicKey));
        } else if (mutation == Mutation.Credit) {
            CreditMutation memory credit = abi.decode(data, (CreditMutation));
            bytes32 structHash =
                keccak256(abi.encode(CREDIT_TYPEHASH, credit.account, credit.keyId, credit.amount, credit.nonce));
            _verifySig(structHash, credit.nonce, sig);
            state.balances[sig.account] += credit.amount;
        } else if (mutation == Mutation.Debit) {
            (DebitMutation memory debit, DebitResolution memory resolution) =
                abi.decode(data, (DebitMutation, DebitResolution));
            bytes32 structHash =
                keccak256(abi.encode(DEBIT_TYPEHASH, debit.account, debit.keyId, debit.amount, debit.nonce));
            _verifySig(structHash, debit.nonce, sig);
            require(state.balances[sig.account] == resolution.newBalance + debit.amount, "debit: stale resolution");
            state.balances[sig.account] = resolution.newBalance;
        } else if (mutation == Mutation.Assert) {
            AssertMutation memory assertion = abi.decode(data, (AssertMutation));
            bytes32 structHash = keccak256(
                abi.encode(ASSERT_TYPEHASH, assertion.account, assertion.keyId, assertion.expected, assertion.nonce)
            );
            _verifySig(structHash, assertion.nonce, sig);
            require(state.balances[sig.account] == assertion.expected, "assert failed");
        } else {
            revert UnknownTag();
        }
    }

    function _applyMemory(Mutation mutation, bytes memory data, Signature memory sig) internal {
        if (mutation == Mutation.Initialize) {
            InitializeMutation memory init = abi.decode(data, (InitializeMutation));
            bytes32 expected = keccak256(init.rootPublicKey);
            if (sig.account != expected) revert InvalidAccount();
            if (state.accounts[expected].keys.length != 0) revert AlreadyInitialized();
            state.accounts[expected].keys.push(Key(init.rootKeyType, init.rootPublicKey));
        } else if (mutation == Mutation.Authorize) {
            AuthorizeMutation memory auth = abi.decode(data, (AuthorizeMutation));
            bytes32 structHash = keccak256(
                abi.encode(
                    AUTHORIZE_TYPEHASH, auth.account, auth.keyId, auth.keyType, keccak256(auth.publicKey), auth.nonce
                )
            );
            _verifySigMemory(structHash, auth.nonce, sig);
            state.accounts[sig.account].keys.push(Key(auth.keyType, auth.publicKey));
        } else if (mutation == Mutation.Credit) {
            CreditMutation memory credit = abi.decode(data, (CreditMutation));
            bytes32 structHash =
                keccak256(abi.encode(CREDIT_TYPEHASH, credit.account, credit.keyId, credit.amount, credit.nonce));
            _verifySigMemory(structHash, credit.nonce, sig);
            state.balances[sig.account] += credit.amount;
        } else if (mutation == Mutation.Debit) {
            (DebitMutation memory debit, DebitResolution memory resolution) =
                abi.decode(data, (DebitMutation, DebitResolution));
            bytes32 structHash =
                keccak256(abi.encode(DEBIT_TYPEHASH, debit.account, debit.keyId, debit.amount, debit.nonce));
            _verifySigMemory(structHash, debit.nonce, sig);
            require(state.balances[sig.account] == resolution.newBalance + debit.amount, "debit: stale resolution");
            state.balances[sig.account] = resolution.newBalance;
        } else if (mutation == Mutation.Assert) {
            AssertMutation memory assertion = abi.decode(data, (AssertMutation));
            bytes32 structHash = keccak256(
                abi.encode(ASSERT_TYPEHASH, assertion.account, assertion.keyId, assertion.expected, assertion.nonce)
            );
            _verifySigMemory(structHash, assertion.nonce, sig);
            require(state.balances[sig.account] == assertion.expected, "assert failed");
        } else {
            revert UnknownTag();
        }
    }
}
