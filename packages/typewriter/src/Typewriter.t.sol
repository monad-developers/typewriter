// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {InvalidSignature, KeyType, verifyChallenge, verifySignature} from "typewriter/Typewriter.sol";

interface Vm {
    function addr(uint256 privateKey) external returns (address);
    function sign(uint256 privateKey, bytes32 digest) external returns (uint8 v, bytes32 r, bytes32 s);
    function signP256(uint256 privateKey, bytes32 digest) external returns (bytes32 r, bytes32 s);
    function publicKeyP256(uint256 privateKey) external returns (uint256 x, uint256 y);
}

contract AccountHarness {
    function verifySignatureExternal(KeyType keyType, bytes32 digest, bytes memory publicKey, bytes calldata signature)
        external
        view
    {
        verifySignature(keyType, digest, publicKey, signature);
    }

    function verifyChallengeExternal(bytes memory clientDataJSON, uint256 offset, bytes32 digest) external pure {
        verifyChallenge(clientDataJSON, offset, digest);
    }
}

contract AccountTest {
    Vm constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    AccountHarness harness;

    uint256 constant SECP256K1_PK = 0xA11CE;
    uint256 constant P256_PK = 0xC0FFEE;
    uint256 constant P256_OTHER_PK = 0xDECAF;

    bytes32 constant DIGEST = bytes32(uint256(0x1111111111111111111111111111111111111111111111111111111111111111));
    string constant CLIENT_DATA_JSON =
        '{"type":"webauthn.get","challenge":"ERERERERERERERERERERERERERERERERERERERERERE","origin":"http://localhost:3000","crossOrigin":false}';
    uint256 constant CHALLENGE_OFFSET = 36;

    function setUp() public {
        harness = new AccountHarness();
    }

    function test_verifySignature_acceptsSecp256k1() external {
        harness.verifySignatureExternal(
            KeyType.Secp256k1, DIGEST, _secp256k1PublicKey(SECP256K1_PK), _signSecp256k1(SECP256K1_PK, DIGEST)
        );
    }

    function test_verifySignature_rejectsSecp256k1ForWrongPublicKey() external {
        bytes memory signature = _signSecp256k1(SECP256K1_PK, DIGEST);
        bytes memory wrongPublicKey = abi.encode(vm.addr(0xB0B));

        _expectInvalidSignature(
            abi.encodeCall(harness.verifySignatureExternal, (KeyType.Secp256k1, DIGEST, wrongPublicKey, signature)),
            KeyType.Secp256k1
        );
    }

    function test_verifySignature_acceptsP256() external {
        harness.verifySignatureExternal(KeyType.P256, DIGEST, _p256PublicKey(P256_PK), _signP256(P256_PK, DIGEST));
    }

    function test_verifySignature_acceptsAbiEncodedP256PublicKey() external {
        (uint256 x, uint256 y) = vm.publicKeyP256(P256_PK);

        harness.verifySignatureExternal(KeyType.P256, DIGEST, abi.encode(x, y), _signP256(P256_PK, DIGEST));
    }

    function test_verifySignature_rejectsP256ForWrongDigest() external {
        _expectInvalidSignature(
            abi.encodeCall(
                harness.verifySignatureExternal,
                (KeyType.P256, bytes32(uint256(0x2222)), _p256PublicKey(P256_PK), _signP256(P256_PK, DIGEST))
            ),
            KeyType.P256
        );
    }

    function test_verifySignature_rejectsP256ForWrongPublicKey() external {
        _expectInvalidSignature(
            abi.encodeCall(
                harness.verifySignatureExternal,
                (KeyType.P256, DIGEST, _p256PublicKey(P256_PK), _signP256(P256_OTHER_PK, DIGEST))
            ),
            KeyType.P256
        );
    }

    function test_verifySignature_acceptsWebAuthnP256() external {
        harness.verifySignatureExternal(
            KeyType.WebAuthnP256, DIGEST, _p256PublicKey(P256_PK), _signWebAuthnP256(P256_PK)
        );
    }

    function test_verifySignature_rejectsWebAuthnP256ForWrongChallengeOffset() external {
        bytes memory signature = _signWebAuthnP256(P256_PK, CHALLENGE_OFFSET + 1);

        _expectInvalidSignature(
            abi.encodeCall(
                harness.verifySignatureExternal, (KeyType.WebAuthnP256, DIGEST, _p256PublicKey(P256_PK), signature)
            ),
            KeyType.WebAuthnP256
        );
    }

    function test_verifyChallenge_acceptsCorrectBase64Challenge() external view {
        harness.verifyChallengeExternal(bytes(CLIENT_DATA_JSON), CHALLENGE_OFFSET, DIGEST);
    }

    function test_verifyChallenge_rejectsMismatchedDigest() external {
        _expectInvalidSignature(
            abi.encodeCall(
                harness.verifyChallengeExternal, (bytes(CLIENT_DATA_JSON), CHALLENGE_OFFSET, bytes32(uint256(0x2222)))
            ),
            KeyType.WebAuthnP256
        );
    }

    function test_verifyChallenge_rejectsTooShortJson() external {
        _expectInvalidSignature(
            abi.encodeCall(harness.verifyChallengeExternal, (bytes('{"challenge":"ERERERER"}'), 14, DIGEST)),
            KeyType.WebAuthnP256
        );
    }

    function _expectInvalidSignature(bytes memory callData, KeyType keyType) internal {
        (bool ok, bytes memory ret) = address(harness).call(callData);
        require(!ok, "expected call to revert");
        require(keccak256(ret) == keccak256(abi.encodeWithSelector(InvalidSignature.selector, keyType)), "wrong revert");
    }

    function _secp256k1PublicKey(uint256 privateKey) internal returns (bytes memory) {
        return abi.encode(vm.addr(privateKey));
    }

    function _signSecp256k1(uint256 privateKey, bytes32 digest) internal returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(privateKey, digest);
        return abi.encode(v, r, s);
    }

    function _p256PublicKey(uint256 privateKey) internal returns (bytes memory) {
        (uint256 x, uint256 y) = vm.publicKeyP256(privateKey);
        return abi.encodePacked(uint8(0x04), x, y);
    }

    function _signP256(uint256 privateKey, bytes32 digest) internal returns (bytes memory) {
        (bytes32 r, bytes32 s) = vm.signP256(privateKey, sha256(abi.encodePacked(digest)));
        return abi.encode(uint256(r), uint256(s));
    }

    function _signWebAuthnP256(uint256 privateKey) internal returns (bytes memory) {
        return _signWebAuthnP256(privateKey, CHALLENGE_OFFSET);
    }

    function _signWebAuthnP256(uint256 privateKey, uint256 challengeOffset) internal returns (bytes memory) {
        bytes memory authData = hex"49960de5880e8c687434170f6476605b8fe4aeb9a28632c7995cf3ba831d97630100000000";
        bytes memory clientDataJSON = bytes(CLIENT_DATA_JSON);
        bytes32 message = sha256(abi.encodePacked(authData, sha256(clientDataJSON)));
        (bytes32 r, bytes32 s) = vm.signP256(privateKey, message);
        return abi.encode(authData, clientDataJSON, challengeOffset, uint256(r), uint256(s));
    }
}
