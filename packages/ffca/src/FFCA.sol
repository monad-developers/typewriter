// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

enum KeyType {
    P256,
    WebAuthnP256,
    Secp256k1
}

bytes32 constant EIP712_DOMAIN_TYPEHASH =
    keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
address constant P256_VERIFIER = address(0x100);

error UnknownMutation(uint8 mutation);
error InvalidSignature(KeyType keyType);

function verifySignature(KeyType keyType, bytes32 digest, bytes memory publicKey, bytes memory signature) view {
    if (keyType == KeyType.Secp256k1) {
        verifySecp256k1(digest, publicKey, signature);
    } else if (keyType == KeyType.P256) {
        verifyP256(digest, publicKey, signature);
    } else {
        verifyWebAuthnP256(digest, publicKey, signature);
    }
}

function verifySecp256k1(bytes32 digest, bytes memory publicKey, bytes memory signature) pure {
    address expected = abi.decode(publicKey, (address));
    (uint8 v, bytes32 r, bytes32 s) = abi.decode(signature, (uint8, bytes32, bytes32));
    address recovered = ecrecover(digest, v, r, s);
    if (recovered == address(0) || recovered != expected) revert InvalidSignature(KeyType.Secp256k1);
}

function verifyP256(bytes32 digest, bytes memory publicKey, bytes memory signature) view {
    (uint256 x, uint256 y) = decodeP256PublicKey(publicKey);
    (uint256 r, uint256 s) = abi.decode(signature, (uint256, uint256));
    (bool ok, bytes memory ret) =
        P256_VERIFIER.staticcall(abi.encode(uint256(sha256(abi.encodePacked(digest))), r, s, x, y));
    if (!ok || ret.length < 32 || abi.decode(ret, (uint256)) != 1) revert InvalidSignature(KeyType.P256);
}

function verifyWebAuthnP256(bytes32 digest, bytes memory publicKey, bytes memory signature) view {
    (uint256 x, uint256 y) = decodeP256PublicKey(publicKey);
    (bytes memory authData, bytes memory clientDataJSON, uint256 challengeOffset, uint256 r, uint256 s) =
        abi.decode(signature, (bytes, bytes, uint256, uint256, uint256));

    verifyChallenge(clientDataJSON, challengeOffset, digest);

    bytes32 message = sha256(abi.encodePacked(authData, sha256(clientDataJSON)));
    (bool ok, bytes memory ret) = P256_VERIFIER.staticcall(abi.encode(uint256(message), r, s, x, y));
    if (!ok || ret.length < 32 || abi.decode(ret, (uint256)) != 1) revert InvalidSignature(KeyType.WebAuthnP256);
}

function decodeP256PublicKey(bytes memory publicKey) pure returns (uint256 x, uint256 y) {
    if (publicKey.length == 65) {
        assembly {
            x := mload(add(publicKey, 33))
            y := mload(add(publicKey, 65))
        }
    } else {
        (x, y) = abi.decode(publicKey, (uint256, uint256));
    }
}

function verifyChallenge(bytes memory clientDataJSON, uint256 offset, bytes32 digest) pure {
    bytes memory table = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    if (offset + 43 > clientDataJSON.length) revert InvalidSignature(KeyType.WebAuthnP256);
    for (uint256 i; i < 32;) {
        uint256 a = uint8(digest[i++]);
        uint256 b = i < 32 ? uint8(digest[i++]) : 0;
        uint256 c = i < 32 ? uint8(digest[i++]) : 0;
        uint256 triple = (a << 16) | (b << 8) | c;
        if (clientDataJSON[offset++] != table[(triple >> 18) & 0x3F]) revert InvalidSignature(KeyType.WebAuthnP256);
        if (clientDataJSON[offset++] != table[(triple >> 12) & 0x3F]) revert InvalidSignature(KeyType.WebAuthnP256);
        if (clientDataJSON[offset++] != table[(triple >> 6) & 0x3F]) revert InvalidSignature(KeyType.WebAuthnP256);
        if (i < 32) {
            if (clientDataJSON[offset++] != table[triple & 0x3F]) revert InvalidSignature(KeyType.WebAuthnP256);
        }
    }
}

abstract contract FFCA {
    struct Batch {
        uint8[] mutations;
        bytes[] mutationData;
        bytes[] signatureData;
    }

    struct QueuedMutation {
        uint8 mutation;
        bytes mutationData;
        bytes signatureData;
        uint256 enqueuedBlock;
    }

    event ForceInclusionQueued(
        uint256 index, uint8 mutation, bytes mutationData, bytes signatureData, uint256 enqueuedBlock
    );

    error UnauthorizedExecute(address caller);
    error ForceInclusionTooEarly(uint256 remainingDelay);
    error ForceInclusionAlreadyExecuted(uint256 index);
    error LengthMismatch();

    address internal immutable SCHEDULER;
    bytes32 internal immutable DOMAIN_SEPARATOR;
    uint256 internal immutable FORCE_INCLUSION_DELAY;

    QueuedMutation[] internal queue;

    function dispatch(uint8 mutation, bytes memory mutationData, bytes memory signatureData) internal virtual;

    function execute(Batch[] calldata batches, uint256[] calldata forceExecuteIndexes) external {
        if (msg.sender != SCHEDULER) revert UnauthorizedExecute(msg.sender);

        for (uint256 b; b < batches.length; b++) {
            Batch calldata batch = batches[b];
            if (
                batch.mutations.length != batch.mutationData.length
                    || batch.mutations.length != batch.signatureData.length
            ) {
                revert LengthMismatch();
            }
            for (uint256 i; i < batch.mutations.length; i++) {
                dispatch(batch.mutations[i], batch.mutationData[i], batch.signatureData[i]);
            }
        }

        for (uint256 i; i < forceExecuteIndexes.length; i++) {
            uint256 index = forceExecuteIndexes[i];
            QueuedMutation storage queued = queue[index];

            if (queued.enqueuedBlock == 0) revert ForceInclusionAlreadyExecuted(index);

            dispatch(queued.mutation, queued.mutationData, queued.signatureData);

            delete queue[index];
        }
    }

    function enqueue(uint8 mutation, bytes calldata mutationData, bytes calldata signatureData)
        external
        returns (uint256)
    {
        uint256 index = queue.length;
        uint256 enqueuedBlock = block.number;
        queue.push(
            QueuedMutation({
                mutation: mutation,
                mutationData: mutationData,
                signatureData: signatureData,
                enqueuedBlock: enqueuedBlock
            })
        );
        emit ForceInclusionQueued(index, mutation, mutationData, signatureData, enqueuedBlock);
        return index;
    }

    function forceExecute(uint256 index) external {
        QueuedMutation storage queued = queue[index];

        if (block.number < queued.enqueuedBlock + FORCE_INCLUSION_DELAY) {
            revert ForceInclusionTooEarly((queued.enqueuedBlock + FORCE_INCLUSION_DELAY) - block.number);
        }
        if (queued.enqueuedBlock == 0) revert ForceInclusionAlreadyExecuted(index);

        dispatch(queued.mutation, queued.mutationData, queued.signatureData);

        delete queue[index];
    }
}
