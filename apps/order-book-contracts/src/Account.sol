// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

enum KeyType {
    P256,
    WebAuthnP256,
    Secp256k1
}

struct Key {
    uint40 expiry;
    KeyType keyType;
    uint8 permissions;
    bytes publicKey;
}

error InvalidSignature();
error KeyNotFound();
error KeyExpired();

address constant P256_VERIFIER = address(0x100);

function verify(Key[] storage keys, bytes32 digest, uint64 keyId, bytes calldata signature) view returns (uint8) {
    Key storage stored = keys[keyId];
    if (stored.permissions == 0) revert KeyNotFound();
    if (stored.expiry != 0 && stored.expiry < block.timestamp) revert KeyExpired();

    verifySignature(stored.keyType, digest, stored.publicKey, signature);
    return stored.permissions;
}

function verifyMemory(Key[] storage keys, bytes32 digest, uint64 keyId, bytes memory signature) view returns (uint8) {
    Key storage stored = keys[keyId];
    if (stored.permissions == 0) revert KeyNotFound();
    if (stored.expiry != 0 && stored.expiry < block.timestamp) revert KeyExpired();

    verifySignatureMemory(stored.keyType, digest, stored.publicKey, signature);
    return stored.permissions;
}

function verifySignature(KeyType keyType, bytes32 digest, bytes memory publicKey, bytes calldata signature) view {
    if (keyType == KeyType.Secp256k1) {
        verifySecp256k1(digest, publicKey, signature);
    } else if (keyType == KeyType.P256) {
        verifyP256(digest, publicKey, signature);
    } else {
        verifyWebAuthnP256(digest, publicKey, signature);
    }
}

function verifySignatureMemory(KeyType keyType, bytes32 digest, bytes memory publicKey, bytes memory signature) view {
    if (keyType == KeyType.Secp256k1) {
        verifySecp256k1Memory(digest, publicKey, signature);
    } else if (keyType == KeyType.P256) {
        verifyP256Memory(digest, publicKey, signature);
    } else {
        verifyWebAuthnP256Memory(digest, publicKey, signature);
    }
}

function verifySecp256k1(bytes32 digest, bytes memory publicKey, bytes calldata signature) pure {
    address expected = abi.decode(publicKey, (address));
    (uint8 v, bytes32 r, bytes32 s) = abi.decode(signature, (uint8, bytes32, bytes32));
    address recovered = ecrecover(digest, v, r, s);
    if (recovered == address(0) || recovered != expected) revert InvalidSignature();
}

function verifySecp256k1Memory(bytes32 digest, bytes memory publicKey, bytes memory signature) pure {
    address expected = abi.decode(publicKey, (address));
    (uint8 v, bytes32 r, bytes32 s) = abi.decode(signature, (uint8, bytes32, bytes32));
    address recovered = ecrecover(digest, v, r, s);
    if (recovered == address(0) || recovered != expected) revert InvalidSignature();
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

function verifyP256(bytes32 digest, bytes memory publicKey, bytes calldata signature) view {
    (uint256 x, uint256 y) = decodeP256PublicKey(publicKey);
    (uint256 r, uint256 s) = abi.decode(signature, (uint256, uint256));
    (bool ok, bytes memory ret) =
        P256_VERIFIER.staticcall(abi.encode(uint256(sha256(abi.encodePacked(digest))), r, s, x, y));
    if (!ok || ret.length < 32 || abi.decode(ret, (uint256)) != 1) revert InvalidSignature();
}

function verifyP256Memory(bytes32 digest, bytes memory publicKey, bytes memory signature) view {
    (uint256 x, uint256 y) = decodeP256PublicKey(publicKey);
    (uint256 r, uint256 s) = abi.decode(signature, (uint256, uint256));
    (bool ok, bytes memory ret) =
        P256_VERIFIER.staticcall(abi.encode(uint256(sha256(abi.encodePacked(digest))), r, s, x, y));
    if (!ok || ret.length < 32 || abi.decode(ret, (uint256)) != 1) revert InvalidSignature();
}

function verifyWebAuthnP256(bytes32 digest, bytes memory publicKey, bytes calldata signature) view {
    (uint256 x, uint256 y) = decodeP256PublicKey(publicKey);
    (bytes memory authData, bytes memory clientDataJSON, uint256 challengeOffset, uint256 r, uint256 s) =
        abi.decode(signature, (bytes, bytes, uint256, uint256, uint256));

    verifyChallenge(clientDataJSON, challengeOffset, digest);

    bytes32 message = sha256(abi.encodePacked(authData, sha256(clientDataJSON)));
    (bool ok, bytes memory ret) = P256_VERIFIER.staticcall(abi.encode(uint256(message), r, s, x, y));
    if (!ok || ret.length < 32 || abi.decode(ret, (uint256)) != 1) revert InvalidSignature();
}

function verifyWebAuthnP256Memory(bytes32 digest, bytes memory publicKey, bytes memory signature) view {
    (uint256 x, uint256 y) = decodeP256PublicKey(publicKey);
    (bytes memory authData, bytes memory clientDataJSON, uint256 challengeOffset, uint256 r, uint256 s) =
        abi.decode(signature, (bytes, bytes, uint256, uint256, uint256));

    verifyChallenge(clientDataJSON, challengeOffset, digest);

    bytes32 message = sha256(abi.encodePacked(authData, sha256(clientDataJSON)));
    (bool ok, bytes memory ret) = P256_VERIFIER.staticcall(abi.encode(uint256(message), r, s, x, y));
    if (!ok || ret.length < 32 || abi.decode(ret, (uint256)) != 1) revert InvalidSignature();
}

function verifyChallenge(bytes memory clientDataJSON, uint256 offset, bytes32 digest) pure {
    bytes memory table = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    if (offset + 43 > clientDataJSON.length) revert InvalidSignature();
    for (uint256 i; i < 32;) {
        uint256 a = uint8(digest[i++]);
        uint256 b = i < 32 ? uint8(digest[i++]) : 0;
        uint256 c = i < 32 ? uint8(digest[i++]) : 0;
        uint256 triple = (a << 16) | (b << 8) | c;
        if (clientDataJSON[offset++] != table[(triple >> 18) & 0x3F]) revert InvalidSignature();
        if (clientDataJSON[offset++] != table[(triple >> 12) & 0x3F]) revert InvalidSignature();
        if (clientDataJSON[offset++] != table[(triple >> 6) & 0x3F]) revert InvalidSignature();
        if (i < 32) {
            if (clientDataJSON[offset++] != table[triple & 0x3F]) revert InvalidSignature();
        }
    }
}
