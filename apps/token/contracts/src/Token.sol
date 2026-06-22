// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {EIP712_DOMAIN_TYPEHASH, FFCA, KeyType, UnknownMutation, verifySignature} from "ffca/FFCA.sol";

struct Signature {
    uint8 keyType;
    bytes rawSignature;
}

struct Account {
    uint256 nonce;
    uint256 balance;
}

struct State {
    uint256 totalSupply;
    mapping(address => Account) accounts;
}

error SignatureExpired();
error InvalidNonce();
error InvalidSignatureType();
error InvalidScheduler();

function verifyTokenSignature(
    State storage state,
    Signature memory signature,
    bytes32 digest,
    address signer,
    uint256 nonce,
    uint256 deadline
) {
    if (deadline < block.timestamp) revert SignatureExpired();
    if (KeyType(signature.keyType) != KeyType.Secp256k1) revert InvalidSignatureType();

    Account storage account = state.accounts[signer];
    if (nonce != account.nonce) revert InvalidNonce();

    verifySignature(KeyType(signature.keyType), digest, abi.encode(signer), signature.rawSignature);

    unchecked {
        account.nonce++;
    }
}

import {MintMutation} from "./Mint.sol";
import {TransferMutation} from "./Transfer.sol";

contract Token is FFCA {
    State internal state;

    enum Mutation {
        Transfer,
        Mint
    }

    constructor(address _scheduler) {
        if (_scheduler == address(0)) revert InvalidScheduler();
        SCHEDULER = _scheduler;
        FORCE_INCLUSION_DELAY = 658;
    }

    function dispatch(uint8 mutation, bytes memory mutationData, bytes memory signatureData) internal override {
        if (mutation == uint8(Mutation.Transfer)) {
            TransferMutation.Transfer memory transfer = abi.decode(mutationData, (TransferMutation.Transfer));
            Signature memory signature = abi.decode(signatureData, (Signature));
            bytes32 digest =
                keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR, TransferMutation.hashTransfer(transfer)));

            TransferMutation.verifyTransferSignature(state, transfer, signature, digest);
            TransferMutation.executeTransfer(state, transfer);
        } else if (mutation == uint8(Mutation.Mint)) {
            MintMutation.Mint memory mint = abi.decode(mutationData, (MintMutation.Mint));
            Signature memory signature = abi.decode(signatureData, (Signature));
            bytes32 digest = keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR, MintMutation.hashMint(mint)));

            MintMutation.verifyMintSignature(state, mint, signature, digest);
            MintMutation.executeMint(state, mint);
        } else {
            revert UnknownMutation(mutation);
        }
    }
}
