// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {FFCA, EIP712_DOMAIN_TYPEHASH, KeyType, UnknownMutation, verifySignature} from "ffca/FFCA.sol";

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
    // Parallel nonces: high 192 bits select a queue; low 64 bits are the
    // sequence within that queue. Same shape the order-book uses so multi-
    // key e2e tests exercise realistic concurrency.
    mapping(uint192 => uint64) nonces;
}

struct State {
    mapping(bytes32 => Account) accounts;
    mapping(bytes32 => uint256) balances;
}

error InvalidAccount();
error AlreadyInitialized();
error InvalidNonce();

function verifyMutationSignature(State storage state, Signature memory signature, bytes32 digest, uint256 nonce) {
    Account storage account = state.accounts[signature.account];
    Key storage key = account.keys[signature.keyId];
    if (key.keyType != signature.keyType) revert InvalidAccount();

    verifySignature(KeyType(signature.keyType), digest, key.publicKey, signature.rawSignature);

    uint192 nonceKey = uint192(nonce >> 64);
    uint64 nonceSeq = uint64(nonce);
    if (nonceSeq != account.nonces[nonceKey]) revert InvalidNonce();
    account.nonces[nonceKey] = nonceSeq + 1;
}

library InitializeMutation {
    struct Initialize {
        uint8 rootKeyType;
        bytes rootPublicKey;
    }

    bytes32 constant INITIALIZE_TYPEHASH = keccak256("Initialize(uint8 rootKeyType,bytes rootPublicKey)");

    function hashInitialize(Initialize memory initialize) internal pure returns (bytes32) {
        return keccak256(abi.encode(INITIALIZE_TYPEHASH, initialize.rootKeyType, keccak256(initialize.rootPublicKey)));
    }

    function executeInitialize(State storage state, Initialize memory initialize, Signature memory signature) internal {
        bytes32 expected = keccak256(initialize.rootPublicKey);
        if (signature.account != expected) revert InvalidAccount();
        if (state.accounts[expected].keys.length != 0) revert AlreadyInitialized();
        state.accounts[expected].keys.push(Key(initialize.rootKeyType, initialize.rootPublicKey));
    }
}

library AuthorizeMutation {
    struct Authorize {
        bytes32 account;
        uint64 keyId;
        uint8 keyType;
        bytes publicKey;
        uint256 nonce;
    }

    bytes32 constant AUTHORIZE_TYPEHASH =
        keccak256("Authorize(bytes32 account,uint64 keyId,uint8 keyType,bytes publicKey,uint256 nonce)");

    function hashAuthorize(Authorize memory authorize) internal pure returns (bytes32) {
        return keccak256(
            abi.encode(
                AUTHORIZE_TYPEHASH,
                authorize.account,
                authorize.keyId,
                authorize.keyType,
                keccak256(authorize.publicKey),
                authorize.nonce
            )
        );
    }

    function verifyAuthorizeSignature(
        State storage state,
        Authorize memory authorize,
        Signature memory signature,
        bytes32 digest
    ) internal {
        verifyMutationSignature(state, signature, digest, authorize.nonce);
    }

    function executeAuthorize(State storage state, Authorize memory authorize, Signature memory signature) internal {
        state.accounts[signature.account].keys.push(Key(authorize.keyType, authorize.publicKey));
    }
}

library CreditMutation {
    struct Credit {
        bytes32 account;
        uint64 keyId;
        uint256 amount;
        uint256 nonce;
    }

    bytes32 constant CREDIT_TYPEHASH = keccak256("Credit(bytes32 account,uint64 keyId,uint256 amount,uint256 nonce)");

    function hashCredit(Credit memory credit) internal pure returns (bytes32) {
        return keccak256(abi.encode(CREDIT_TYPEHASH, credit.account, credit.keyId, credit.amount, credit.nonce));
    }

    function verifyCreditSignature(
        State storage state,
        Credit memory credit,
        Signature memory signature,
        bytes32 digest
    ) internal {
        verifyMutationSignature(state, signature, digest, credit.nonce);
    }

    function executeCredit(State storage state, Credit memory credit, Signature memory signature) internal {
        state.balances[signature.account] += credit.amount;
    }
}

library DebitMutation {
    struct Debit {
        bytes32 account;
        uint64 keyId;
        uint256 amount;
        uint256 nonce;
    }

    bytes32 constant DEBIT_TYPEHASH = keccak256("Debit(bytes32 account,uint64 keyId,uint256 amount,uint256 nonce)");

    function hashDebit(Debit memory debit) internal pure returns (bytes32) {
        return keccak256(abi.encode(DEBIT_TYPEHASH, debit.account, debit.keyId, debit.amount, debit.nonce));
    }

    function verifyDebitSignature(State storage state, Debit memory debit, Signature memory signature, bytes32 digest)
        internal
    {
        verifyMutationSignature(state, signature, digest, debit.nonce);
    }

    function executeDebit(State storage state, Debit memory debit, Signature memory signature) internal {
        state.balances[signature.account] -= debit.amount;
    }
}

library AssertMutation {
    struct Assert {
        bytes32 account;
        uint64 keyId;
        uint256 expected;
        uint256 nonce;
    }

    bytes32 constant ASSERT_TYPEHASH = keccak256("Assert(bytes32 account,uint64 keyId,uint256 expected,uint256 nonce)");

    function hashAssert(Assert memory assertion) internal pure returns (bytes32) {
        return
            keccak256(
                abi.encode(ASSERT_TYPEHASH, assertion.account, assertion.keyId, assertion.expected, assertion.nonce)
            );
    }

    function verifyAssertSignature(
        State storage state,
        Assert memory assertion,
        Signature memory signature,
        bytes32 digest
    ) internal {
        verifyMutationSignature(state, signature, digest, assertion.nonce);
    }

    function executeAssert(State storage state, Assert memory assertion, Signature memory signature) internal view {
        require(state.balances[signature.account] == assertion.expected, "assert failed");
    }
}

/// Multi-key fixture for ffca's submit path. Accounts are 32-byte ids; each
/// holds a list of keys (any of the three KeyTypes from FFCA.sol).
/// Signatures carry (account, keyId, keyType, rawSignature). All mutations
/// except `Initialize` are signed; their EIP-712 digest binds (account,
/// keyId, nonce, …) so a stale or replayed signature can't land.
///
/// Tags:
///   INITIALIZE (0): args = (rootKeyType, rootPublicKey). No signature
///                    needed — account is derived as keccak256(rootPublicKey)
///                    so the publicKey itself authenticates the bootstrap.
///   AUTHORIZE  (1): args = (account, keyId, keyType, publicKey, nonce).
///                    Signed by an existing key on `account`.
///   CREDIT     (2): args = (account, keyId, amount, nonce). Signed.
///   DEBIT      (3): args = (account, keyId, amount, nonce). Signed.
///   ASSERT     (4): args = (account, keyId, expected, nonce). Signed.
///                    Read-only — reverts if balance != expected.
contract Harness is FFCA {
    State internal state;

    enum Mutation {
        Initialize,
        Authorize,
        Credit,
        Debit,
        Assert
    }

    constructor() {
        SCHEDULER = msg.sender;
        DOMAIN_SEPARATOR = keccak256(
            abi.encode(
                EIP712_DOMAIN_TYPEHASH, keccak256(bytes("Harness")), keccak256(bytes("1")), block.chainid, address(this)
            )
        );
        // .0001 downtime / month / (.4 s / block) * 2,629,800 s / month
        FORCE_INCLUSION_DELAY = 658;
    }

    function dispatch(uint8 mutation, bytes memory mutationData, bytes memory signatureData) internal override {
        if (Mutation(mutation) == Mutation.Initialize) {
            InitializeMutation.Initialize memory initialize = abi.decode(mutationData, (InitializeMutation.Initialize));
            Signature memory signature = abi.decode(signatureData, (Signature));

            InitializeMutation.executeInitialize(state, initialize, signature);
        } else if (Mutation(mutation) == Mutation.Authorize) {
            AuthorizeMutation.Authorize memory authorize = abi.decode(mutationData, (AuthorizeMutation.Authorize));
            Signature memory signature = abi.decode(signatureData, (Signature));

            bytes32 structHash = AuthorizeMutation.hashAuthorize(authorize);
            bytes32 digest = keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR, structHash));

            AuthorizeMutation.verifyAuthorizeSignature(state, authorize, signature, digest);
            AuthorizeMutation.executeAuthorize(state, authorize, signature);
        } else if (Mutation(mutation) == Mutation.Credit) {
            CreditMutation.Credit memory credit = abi.decode(mutationData, (CreditMutation.Credit));
            Signature memory signature = abi.decode(signatureData, (Signature));

            bytes32 structHash = CreditMutation.hashCredit(credit);
            bytes32 digest = keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR, structHash));

            CreditMutation.verifyCreditSignature(state, credit, signature, digest);
            CreditMutation.executeCredit(state, credit, signature);
        } else if (Mutation(mutation) == Mutation.Debit) {
            DebitMutation.Debit memory debit = abi.decode(mutationData, (DebitMutation.Debit));
            Signature memory signature = abi.decode(signatureData, (Signature));

            bytes32 structHash = DebitMutation.hashDebit(debit);
            bytes32 digest = keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR, structHash));

            DebitMutation.verifyDebitSignature(state, debit, signature, digest);
            DebitMutation.executeDebit(state, debit, signature);
        } else if (Mutation(mutation) == Mutation.Assert) {
            AssertMutation.Assert memory assertion = abi.decode(mutationData, (AssertMutation.Assert));
            Signature memory signature = abi.decode(signatureData, (Signature));

            bytes32 structHash = AssertMutation.hashAssert(assertion);
            bytes32 digest = keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR, structHash));

            AssertMutation.verifyAssertSignature(state, assertion, signature, digest);
            AssertMutation.executeAssert(state, assertion, signature);
        } else {
            revert UnknownMutation(mutation);
        }
    }
}
