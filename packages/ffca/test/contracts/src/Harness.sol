// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {
    FFCA,
    EIP712_DOMAIN_TYPEHASH,
    KeyType,
    UnknownMutation,
    UnauthorizedExecute,
    ForceInclusionTooEarly,
    ForceInclusionAlreadyExecuted,
    verifySignature
} from "ffca/FFCA.sol";

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

    bytes32 constant INITIALIZE_TYPEHASH = keccak256("initialize(uint8 rootKeyType,bytes rootPublicKey)");

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
        keccak256("authorize(bytes32 account,uint64 keyId,uint8 keyType,bytes publicKey,uint256 nonce)");

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

    bytes32 constant CREDIT_TYPEHASH = keccak256("credit(bytes32 account,uint64 keyId,uint256 amount,uint256 nonce)");

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

    struct DebitResolution {
        uint256 newBalance;
    }

    bytes32 constant DEBIT_TYPEHASH = keccak256("debit(bytes32 account,uint64 keyId,uint256 amount,uint256 nonce)");

    function verifyDebitSignature(State storage state, Debit memory debit, Signature memory signature, bytes32 digest)
        internal
    {
        verifyMutationSignature(state, signature, digest, debit.nonce);
    }

    function executeDebit(
        State storage state,
        Debit memory debit,
        DebitResolution memory resolution,
        Signature memory signature
    ) internal {
        require(state.balances[signature.account] == resolution.newBalance + debit.amount, "debit: stale resolution");
        state.balances[signature.account] = resolution.newBalance;
    }
}

library AssertMutation {
    struct Assert {
        bytes32 account;
        uint64 keyId;
        uint256 expected;
        uint256 nonce;
    }

    bytes32 constant ASSERT_TYPEHASH = keccak256("assert(bytes32 account,uint64 keyId,uint256 expected,uint256 nonce)");

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

// .0001 downtime / month / (.4 s / block) * 2,629,800 s / month
uint256 constant FORCE_INCLUSION_DELAY = 658;

/// Multi-key fixture for ffca's submit path. Accounts are 32-byte ids; each
/// holds a list of keys (any of the three KeyTypes from FFCA.sol).
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
    }

    function execute(Batch[] calldata batches, uint256[] calldata forceExecuteIndexes) external override {
        if (msg.sender != SCHEDULER) revert UnauthorizedExecute(msg.sender);

        for (uint256 i; i < forceExecuteIndexes.length; i++) {
            uint256 index = forceExecuteIndexes[i];
            QueuedMutation storage queued = queue[index];

            if (queued.enqueuedBlock == 0) revert ForceInclusionAlreadyExecuted(index);

            if (Mutation(queued.mutation) == Mutation.Initialize) {
                InitializeMutation.Initialize memory initialize =
                    abi.decode(queued.mutationData, (InitializeMutation.Initialize));
                Signature memory signature = abi.decode(queued.signature, (Signature));

                InitializeMutation.executeInitialize(state, initialize, signature);
            } else if (Mutation(queued.mutation) == Mutation.Authorize) {
                AuthorizeMutation.Authorize memory authorize =
                    abi.decode(queued.mutationData, (AuthorizeMutation.Authorize));
                Signature memory signature = abi.decode(queued.signature, (Signature));

                bytes32 structHash = keccak256(
                    abi.encode(
                        AuthorizeMutation.AUTHORIZE_TYPEHASH,
                        authorize.account,
                        authorize.keyId,
                        authorize.keyType,
                        keccak256(authorize.publicKey),
                        authorize.nonce
                    )
                );
                bytes32 digest = keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR, structHash));

                AuthorizeMutation.verifyAuthorizeSignature(state, authorize, signature, digest);
                AuthorizeMutation.executeAuthorize(state, authorize, signature);
            } else if (Mutation(queued.mutation) == Mutation.Credit) {
                CreditMutation.Credit memory credit = abi.decode(queued.mutationData, (CreditMutation.Credit));
                Signature memory signature = abi.decode(queued.signature, (Signature));

                bytes32 structHash = keccak256(
                    abi.encode(
                        CreditMutation.CREDIT_TYPEHASH, credit.account, credit.keyId, credit.amount, credit.nonce
                    )
                );
                bytes32 digest = keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR, structHash));

                CreditMutation.verifyCreditSignature(state, credit, signature, digest);
                CreditMutation.executeCredit(state, credit, signature);
            } else if (Mutation(queued.mutation) == Mutation.Debit) {
                (DebitMutation.Debit memory debit, DebitMutation.DebitResolution memory resolution) =
                    abi.decode(queued.mutationData, (DebitMutation.Debit, DebitMutation.DebitResolution));
                Signature memory signature = abi.decode(queued.signature, (Signature));

                bytes32 structHash = keccak256(
                    abi.encode(DebitMutation.DEBIT_TYPEHASH, debit.account, debit.keyId, debit.amount, debit.nonce)
                );
                bytes32 digest = keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR, structHash));

                DebitMutation.verifyDebitSignature(state, debit, signature, digest);
                DebitMutation.executeDebit(state, debit, resolution, signature);
            } else if (Mutation(queued.mutation) == Mutation.Assert) {
                AssertMutation.Assert memory assertion = abi.decode(queued.mutationData, (AssertMutation.Assert));
                Signature memory signature = abi.decode(queued.signature, (Signature));

                bytes32 structHash = keccak256(
                    abi.encode(
                        AssertMutation.ASSERT_TYPEHASH,
                        assertion.account,
                        assertion.keyId,
                        assertion.expected,
                        assertion.nonce
                    )
                );
                bytes32 digest = keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR, structHash));

                AssertMutation.verifyAssertSignature(state, assertion, signature, digest);
                AssertMutation.executeAssert(state, assertion, signature);
            } else {
                revert UnknownMutation(queued.mutation);
            }

            delete queue[index];
        }

        for (uint256 b; b < batches.length; b++) {
            Batch calldata batch = batches[b];
            for (uint256 i; i < batch.mutations.length; i++) {
                if (Mutation(batch.mutations[i]) == Mutation.Initialize) {
                    InitializeMutation.Initialize memory initialize =
                        abi.decode(batch.mutationData[i], (InitializeMutation.Initialize));
                    Signature memory signature = abi.decode(batch.signatures[i], (Signature));

                    InitializeMutation.executeInitialize(state, initialize, signature);
                } else if (Mutation(batch.mutations[i]) == Mutation.Authorize) {
                    AuthorizeMutation.Authorize memory authorize =
                        abi.decode(batch.mutationData[i], (AuthorizeMutation.Authorize));
                    Signature memory signature = abi.decode(batch.signatures[i], (Signature));

                    bytes32 structHash = keccak256(
                        abi.encode(
                            AuthorizeMutation.AUTHORIZE_TYPEHASH,
                            authorize.account,
                            authorize.keyId,
                            authorize.keyType,
                            keccak256(authorize.publicKey),
                            authorize.nonce
                        )
                    );
                    bytes32 digest = keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR, structHash));

                    AuthorizeMutation.verifyAuthorizeSignature(state, authorize, signature, digest);
                    AuthorizeMutation.executeAuthorize(state, authorize, signature);
                } else if (Mutation(batch.mutations[i]) == Mutation.Credit) {
                    CreditMutation.Credit memory credit = abi.decode(batch.mutationData[i], (CreditMutation.Credit));
                    Signature memory signature = abi.decode(batch.signatures[i], (Signature));

                    bytes32 structHash = keccak256(
                        abi.encode(
                            CreditMutation.CREDIT_TYPEHASH, credit.account, credit.keyId, credit.amount, credit.nonce
                        )
                    );
                    bytes32 digest = keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR, structHash));

                    CreditMutation.verifyCreditSignature(state, credit, signature, digest);
                    CreditMutation.executeCredit(state, credit, signature);
                } else if (Mutation(batch.mutations[i]) == Mutation.Debit) {
                    (DebitMutation.Debit memory debit, DebitMutation.DebitResolution memory resolution) =
                        abi.decode(batch.mutationData[i], (DebitMutation.Debit, DebitMutation.DebitResolution));
                    Signature memory signature = abi.decode(batch.signatures[i], (Signature));

                    bytes32 structHash = keccak256(
                        abi.encode(DebitMutation.DEBIT_TYPEHASH, debit.account, debit.keyId, debit.amount, debit.nonce)
                    );
                    bytes32 digest = keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR, structHash));

                    DebitMutation.verifyDebitSignature(state, debit, signature, digest);
                    DebitMutation.executeDebit(state, debit, resolution, signature);
                } else if (Mutation(batch.mutations[i]) == Mutation.Assert) {
                    AssertMutation.Assert memory assertion = abi.decode(batch.mutationData[i], (AssertMutation.Assert));
                    Signature memory signature = abi.decode(batch.signatures[i], (Signature));

                    bytes32 structHash = keccak256(
                        abi.encode(
                            AssertMutation.ASSERT_TYPEHASH,
                            assertion.account,
                            assertion.keyId,
                            assertion.expected,
                            assertion.nonce
                        )
                    );
                    bytes32 digest = keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR, structHash));

                    AssertMutation.verifyAssertSignature(state, assertion, signature, digest);
                    AssertMutation.executeAssert(state, assertion, signature);
                } else {
                    revert UnknownMutation(batch.mutations[i]);
                }
            }
        }
    }

    function forceExecute(uint256 index) external override {
        QueuedMutation storage queued = queue[index];

        if (block.number < queued.enqueuedBlock + FORCE_INCLUSION_DELAY) {
            revert ForceInclusionTooEarly((queued.enqueuedBlock + FORCE_INCLUSION_DELAY) - block.number);
        }
        if (queued.enqueuedBlock == 0) revert ForceInclusionAlreadyExecuted(index);

        if (Mutation(queued.mutation) == Mutation.Initialize) {
            InitializeMutation.Initialize memory initialize =
                abi.decode(queued.mutationData, (InitializeMutation.Initialize));
            Signature memory signature = abi.decode(queued.signature, (Signature));

            InitializeMutation.executeInitialize(state, initialize, signature);
        } else if (Mutation(queued.mutation) == Mutation.Authorize) {
            AuthorizeMutation.Authorize memory authorize =
                abi.decode(queued.mutationData, (AuthorizeMutation.Authorize));
            Signature memory signature = abi.decode(queued.signature, (Signature));

            bytes32 structHash = keccak256(
                abi.encode(
                    AuthorizeMutation.AUTHORIZE_TYPEHASH,
                    authorize.account,
                    authorize.keyId,
                    authorize.keyType,
                    keccak256(authorize.publicKey),
                    authorize.nonce
                )
            );
            bytes32 digest = keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR, structHash));

            AuthorizeMutation.verifyAuthorizeSignature(state, authorize, signature, digest);
            AuthorizeMutation.executeAuthorize(state, authorize, signature);
        } else if (Mutation(queued.mutation) == Mutation.Credit) {
            CreditMutation.Credit memory credit = abi.decode(queued.mutationData, (CreditMutation.Credit));
            Signature memory signature = abi.decode(queued.signature, (Signature));

            bytes32 structHash = keccak256(
                abi.encode(CreditMutation.CREDIT_TYPEHASH, credit.account, credit.keyId, credit.amount, credit.nonce)
            );
            bytes32 digest = keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR, structHash));

            CreditMutation.verifyCreditSignature(state, credit, signature, digest);
            CreditMutation.executeCredit(state, credit, signature);
        } else if (Mutation(queued.mutation) == Mutation.Debit) {
            (DebitMutation.Debit memory debit, DebitMutation.DebitResolution memory resolution) =
                abi.decode(queued.mutationData, (DebitMutation.Debit, DebitMutation.DebitResolution));
            Signature memory signature = abi.decode(queued.signature, (Signature));

            bytes32 structHash = keccak256(
                abi.encode(DebitMutation.DEBIT_TYPEHASH, debit.account, debit.keyId, debit.amount, debit.nonce)
            );
            bytes32 digest = keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR, structHash));

            DebitMutation.verifyDebitSignature(state, debit, signature, digest);
            DebitMutation.executeDebit(state, debit, resolution, signature);
        } else if (Mutation(queued.mutation) == Mutation.Assert) {
            AssertMutation.Assert memory assertion = abi.decode(queued.mutationData, (AssertMutation.Assert));
            Signature memory signature = abi.decode(queued.signature, (Signature));

            bytes32 structHash = keccak256(
                abi.encode(
                    AssertMutation.ASSERT_TYPEHASH,
                    assertion.account,
                    assertion.keyId,
                    assertion.expected,
                    assertion.nonce
                )
            );
            bytes32 digest = keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR, structHash));

            AssertMutation.verifyAssertSignature(state, assertion, signature, digest);
            AssertMutation.executeAssert(state, assertion, signature);
        } else {
            revert UnknownMutation(queued.mutation);
        }

        delete queue[index];
    }
}
