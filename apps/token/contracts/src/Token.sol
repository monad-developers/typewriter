// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {EIP712_DOMAIN_TYPEHASH, KeyType, verifySignature} from "ffca/FFCA.sol";

struct Signature {
    uint8 keyType;
    bytes rawSignature;
}

struct Bundle {
    uint8[] mutations;
    bytes[] mutationData;
    Signature[] signatures;
}

struct TransferMutation {
    address from;
    address to;
    uint256 amount;
    uint256 nonce;
    uint256 deadline;
}

struct MintMutation {
    address to;
    uint256 amount;
    uint256 nonce;
    uint256 deadline;
}

struct Account {
    uint256 nonce;
    uint256 balance;
}

contract Token {
    uint8 public constant TRANSFER = 0;
    uint8 public constant MINT = 1;

    uint256 public totalSupply;
    mapping(address => Account) public accounts;

    address public immutable scheduler;
    bytes32 public immutable domainSeparator;

    bytes32 public constant TRANSFER_TYPEHASH =
        keccak256("Transfer(address from,address to,uint256 amount,uint256 nonce,uint256 deadline)");
    bytes32 public constant MINT_TYPEHASH = keccak256("Mint(address to,uint256 amount,uint256 nonce,uint256 deadline)");

    error Unauthorized();
    error LengthMismatch();
    error SignatureExpired();
    error InvalidNonce();
    error InvalidMutation();
    error ForceInclusionUnsupported();
    error InvalidScheduler();
    error InvalidSignatureType();

    event ForceInclusionQueued(uint256 index, uint8 mutation, bytes mutationData, Signature sig, uint256 enqueuedBlock);

    constructor(address _scheduler) {
        if (_scheduler == address(0)) revert InvalidScheduler();
        scheduler = _scheduler;
        domainSeparator = keccak256(
            abi.encode(
                EIP712_DOMAIN_TYPEHASH, keccak256(bytes("Token")), keccak256(bytes("1")), block.chainid, address(this)
            )
        );
    }

    function execute(Bundle[] calldata batches, uint256[] calldata forceExecuteIndexes) external {
        if (msg.sender != scheduler) revert Unauthorized();
        if (forceExecuteIndexes.length != 0) revert ForceInclusionUnsupported();

        for (uint256 b; b < batches.length; b++) {
            Bundle calldata bundle = batches[b];
            if (
                bundle.mutations.length != bundle.mutationData.length
                    || bundle.mutations.length != bundle.signatures.length
            ) {
                revert LengthMismatch();
            }

            for (uint256 i; i < bundle.mutations.length; i++) {
                uint8 mutation = bundle.mutations[i];
                if (mutation == TRANSFER) {
                    _transfer(abi.decode(bundle.mutationData[i], (TransferMutation)), bundle.signatures[i]);
                } else if (mutation == MINT) {
                    _mint(abi.decode(bundle.mutationData[i], (MintMutation)), bundle.signatures[i]);
                } else {
                    revert InvalidMutation();
                }
            }
        }
    }

    function enqueue(uint8, bytes calldata, Signature calldata) external pure {
        revert ForceInclusionUnsupported();
    }

    function forceExecute(uint256) external pure {
        revert ForceInclusionUnsupported();
    }

    function _transfer(TransferMutation memory transfer, Signature calldata sig) internal {
        if (transfer.deadline < block.timestamp) revert SignatureExpired();
        Account storage from = accounts[transfer.from];
        if (transfer.nonce != from.nonce) revert InvalidNonce();

        bytes32 structHash = keccak256(
            abi.encode(
                TRANSFER_TYPEHASH, transfer.from, transfer.to, transfer.amount, transfer.nonce, transfer.deadline
            )
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", domainSeparator, structHash));
        if (KeyType(sig.keyType) != KeyType.Secp256k1) revert InvalidSignatureType();
        verifySignature(KeyType(sig.keyType), digest, abi.encode(transfer.from), sig.rawSignature);

        from.nonce++;
        from.balance -= transfer.amount;
        unchecked {
            accounts[transfer.to].balance += transfer.amount;
        }
    }

    function _mint(MintMutation memory mint, Signature calldata sig) internal {
        if (mint.deadline < block.timestamp) revert SignatureExpired();
        Account storage to = accounts[mint.to];
        if (mint.nonce != to.nonce) revert InvalidNonce();

        bytes32 structHash = keccak256(abi.encode(MINT_TYPEHASH, mint.to, mint.amount, mint.nonce, mint.deadline));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", domainSeparator, structHash));
        if (KeyType(sig.keyType) != KeyType.Secp256k1) revert InvalidSignatureType();
        verifySignature(KeyType(sig.keyType), digest, abi.encode(mint.to), sig.rawSignature);

        to.nonce++;
        totalSupply += mint.amount;
        unchecked {
            to.balance += mint.amount;
        }
    }
}
