// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";

import {InvalidSignature, verifyChallenge} from "src/Account.sol";

contract VerifyChallengeHarness {
    function call(bytes memory clientDataJSON, uint256 offset, bytes32 digest) external pure {
        verifyChallenge(clientDataJSON, offset, digest);
    }
}

contract VerifyChallengeTest is Test {
    VerifyChallengeHarness harness;

    bytes32 constant DIGEST = bytes32(uint256(0x1111111111111111111111111111111111111111111111111111111111111111));

    string constant CLIENT_DATA_JSON =
        '{"type":"webauthn.get","challenge":"ERERERERERERERERERERERERERERERERERERERERERE","origin":"http://localhost:3000","crossOrigin":false}';

    uint256 constant CHALLENGE_OFFSET = 36;

    function setUp() public {
        harness = new VerifyChallengeHarness();
    }

    function test_acceptsCorrectBase64Challenge() public view {
        harness.call(bytes(CLIENT_DATA_JSON), CHALLENGE_OFFSET, DIGEST);
    }

    function test_rejectsMismatchedDigest() public {
        bytes32 wrongDigest = bytes32(uint256(0x2222222222222222222222222222222222222222222222222222222222222222));
        vm.expectRevert(InvalidSignature.selector);
        harness.call(bytes(CLIENT_DATA_JSON), CHALLENGE_OFFSET, wrongDigest);
    }

    function test_rejectsTooShortJson() public {
        bytes memory shortJson = bytes('{"challenge":"ERERERER"}');
        vm.expectRevert(InvalidSignature.selector);
        harness.call(shortJson, 14, DIGEST);
    }
}
