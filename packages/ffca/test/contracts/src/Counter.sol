// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {FFCA, EIP712_DOMAIN_TYPEHASH, KeyType, UnknownMutation, verifySignature} from "ffca/FFCA.sol";

struct Account {
    KeyType keyType;
    bytes publicKey;
    uint256 nonce;
}

struct State {
    uint256 total;
    mapping(bytes32 accountId => Account) accounts;
}

struct Signature {
    bytes32 accountId;
    bytes publicKey;
    bytes rawSignature;
}

error AccountExists(bytes32 accountId);
error InvalidNonce(uint256 expectedNonce, uint256 receivedNonce);

library NewAccountMutation {
    struct NewAccount {
        KeyType keyType;
        bytes publicKey;
    }

    function executeNewAccount(State storage state, NewAccount memory newAccount) internal {
        bytes32 accountId = keccak256(newAccount.publicKey);

        if (state.accounts[accountId].nonce != 0) revert AccountExists(accountId);

        state.accounts[accountId].keyType = newAccount.keyType;
        state.accounts[accountId].publicKey = newAccount.publicKey;
    }
}

library AddMutation {
    struct Add {
        uint256 amount;
        uint256 nonce;
    }

    function executeAdd(State storage state, Add memory add) internal {
        state.total += add.amount;
    }

    bytes32 constant ADD_TYPEHASH = keccak256("add(uint256 amount,uint256 nonce)");

    function hashAdd(Add memory add) internal pure returns (bytes32) {
        return keccak256(abi.encode(AddMutation.ADD_TYPEHASH, add.amount, add.nonce));
    }

    function verifyAddSignature(State storage state, Add memory add, Signature memory signature, bytes32 digest)
        internal
    {
        Account storage account = state.accounts[signature.accountId];
        if (account.nonce != add.nonce) revert InvalidNonce(account.nonce, add.nonce);
        bytes memory publicKey = account.publicKey.length == 0 ? signature.publicKey : account.publicKey;
        if (publicKey.length == 0) revert InvalidNonce(account.nonce, add.nonce);
        KeyType keyType = account.publicKey.length == 0 ? KeyType.Secp256k1 : KeyType(account.keyType);
        verifySignature(keyType, digest, publicKey, signature.rawSignature);
        account.nonce++;
    }
}

/// Single-signer secp256k1 fixture for ffca's submit path. `add` mutations
/// must be EIP-712-signed by the address set at construction time. ffca's
/// local `apply` mirrors the addition; the contract enforces the signature
/// and the nonce.
contract Counter is FFCA {
    State internal state;

    enum Mutation {
        NewAccount,
        Add
    }

    constructor() {
        SCHEDULER = msg.sender;
        DOMAIN_SEPARATOR = keccak256(
            abi.encode(
                EIP712_DOMAIN_TYPEHASH, keccak256(bytes("Counter")), keccak256(bytes("1")), block.chainid, address(this)
            )
        );
        // .0001 downtime / month / (.4 s / block) * 2,629,800 s / month
        FORCE_INCLUSION_DELAY = 658;
    }

    function dispatch(uint8 mutation, bytes memory mutationData, bytes memory signatureData) internal override {
        if (Mutation(mutation) == Mutation.NewAccount) {
            NewAccountMutation.NewAccount memory newAccount = abi.decode(mutationData, (NewAccountMutation.NewAccount));
            NewAccountMutation.executeNewAccount(state, newAccount);
        } else if (Mutation(mutation) == Mutation.Add) {
            AddMutation.Add memory add = abi.decode(mutationData, (AddMutation.Add));
            Signature memory signature = abi.decode(signatureData, (Signature));

            bytes32 structHash = AddMutation.hashAdd(add);
            bytes32 digest = keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR, structHash));

            AddMutation.verifyAddSignature(state, add, signature, digest);
            AddMutation.executeAdd(state, add);
        } else {
            revert UnknownMutation(mutation);
        }
    }
}
