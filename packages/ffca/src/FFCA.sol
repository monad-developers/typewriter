// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

bytes32 constant EIP712_DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");

abstract contract FFCA {

    struct Batch {
        uint8[] mutations;
        bytes[] mutationData;
        bytes[] signatures;
    }

    struct QueuedMutation {
        uint8 mutation;
        bytes mutationData;
        bytes signature;
        uint256 enqueuedBlock;
    }

    event ForceInclusionQueued(uint256 index, uint8 mutation, bytes mutationData, bytes signature, uint256 enqueuedBlock);

    address immutable internal SCHEDULER;
    bytes32 immutable internal DOMAIN_SEPARATOR;

    QueuedMutation[] internal queue;

    function enqueue(uint8 mutation, bytes calldata mutationData, bytes calldata signature) external returns (uint256) {
        uint256 index = queue.length;
        uint256 enqueuedBlock = block.number;
        queue.push(
            QueuedMutation({mutation: mutation, mutationData: mutationData, signature: signature, enqueuedBlock: enqueuedBlock})
        );
        emit ForceInclusionQueued(index, mutation, mutationData, signature, enqueuedBlock);
        return index;
    }
}
