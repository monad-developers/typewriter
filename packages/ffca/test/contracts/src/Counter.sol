// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {EIP712_DOMAIN_TYPEHASH} from "ffca/FFCA.sol";
import {KeyType, verifySignature, verifySignatureMemory} from "ffca/Account.sol";

struct Signature {
    uint8 keyType;
    bytes rawSignature;
}

struct Bundle {
    uint8[] mutations;
    bytes[] mutationData;
    Signature[] signatures;
}

struct State {
    uint256 total;
    uint256 nonce;
}

struct AddMutation {
    uint256 amount;
    uint256 nonce;
}

struct QueuedMutation {
    uint8 mutation;
    bytes mutationData;
    Signature sig;
    uint256 enqueuedBlock;
}

// .0001 downtime / month / (.4 s / block) * 2,629,800 s / month
uint256 constant FORCE_INCLUSION_DELAY = 658;

bytes32 constant ADD_TYPEHASH = keccak256("add(uint256 amount,uint256 nonce)");

/// Single-signer secp256k1 fixture for ffca's submit path. `add` mutations
/// must be EIP-712-signed by the address set at construction time. ffca's
/// local `apply` mirrors the addition; the contract enforces the signature
/// and the nonce.
contract Counter {
    State public state;
    address public immutable signer;
    address public immutable scheduler;
    bytes32 public immutable domainSeparator;

    QueuedMutation[] private queue;

    uint8 constant ADD = 0;

    error Unauthorized();
    error InvalidNonce();
    error UnknownTag();
    error TooEarly();
    error AlreadyExecuted();

    event ForceInclusionQueued(uint256 index, uint8 mutation, bytes mutationData, Signature sig, uint256 enqueuedBlock);

    constructor(address _signer) {
        signer = _signer;
        scheduler = msg.sender;
        domainSeparator = keccak256(
            abi.encode(
                EIP712_DOMAIN_TYPEHASH, keccak256(bytes("Counter")), keccak256(bytes("1")), block.chainid, address(this)
            )
        );
    }

    function execute(Bundle[] calldata bundles, uint256[] calldata forceExecuteIndexes) public {
        if (msg.sender != scheduler) revert Unauthorized();

        for (uint256 i; i < forceExecuteIndexes.length; i++) {
            uint256 index = forceExecuteIndexes[i];
            QueuedMutation storage queued = queue[index];

            if (queued.enqueuedBlock == 0) revert AlreadyExecuted();

            uint8 mutation = queued.mutation;
            bytes memory mutationData = queued.mutationData;
            Signature memory sig = queued.sig;

            delete queue[index];

            if (mutation != ADD) revert UnknownTag();

            AddMutation memory add = abi.decode(mutationData, (AddMutation));

            if (add.nonce != state.nonce) revert InvalidNonce();

            bytes32 structHash = keccak256(abi.encode(ADD_TYPEHASH, add.amount, add.nonce));
            bytes32 digest = keccak256(abi.encodePacked("\x19\x01", domainSeparator, structHash));

            verifySignatureMemory(KeyType(sig.keyType), digest, abi.encode(signer), sig.rawSignature);

            state.nonce++;
            state.total += add.amount;
        }

        for (uint256 b; b < bundles.length; b++) {
            Bundle calldata bundle = bundles[b];
            for (uint256 i; i < bundle.mutations.length; i++) {
                if (bundle.mutations[i] != ADD) revert UnknownTag();

                AddMutation memory add = abi.decode(bundle.mutationData[i], (AddMutation));
                if (add.nonce != state.nonce) revert InvalidNonce();

                bytes32 structHash = keccak256(abi.encode(ADD_TYPEHASH, add.amount, add.nonce));
                bytes32 digest = keccak256(abi.encodePacked("\x19\x01", domainSeparator, structHash));
                Signature calldata sig = bundle.signatures[i];

                verifySignature(KeyType(sig.keyType), digest, abi.encode(signer), sig.rawSignature);

                state.nonce++;
                state.total += add.amount;
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

        uint8 mutation = queued.mutation;
        bytes memory mutationData = queued.mutationData;
        Signature memory sig = queued.sig;

        delete queue[index];

        if (mutation != ADD) revert UnknownTag();

        AddMutation memory add = abi.decode(mutationData, (AddMutation));

        if (add.nonce != state.nonce) revert InvalidNonce();

        bytes32 structHash = keccak256(abi.encode(ADD_TYPEHASH, add.amount, add.nonce));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", domainSeparator, structHash));

        verifySignatureMemory(KeyType(sig.keyType), digest, abi.encode(signer), sig.rawSignature);

        state.nonce++;
        state.total += add.amount;
    }
}
