// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {Bundle, Signature, Token} from "../src/Token.sol";

contract TokenTest is Test {
    Token token;
    address scheduler = address(0x1234);
    uint256 minterPrivateKey = 1;
    address minter = vm.addr(minterPrivateKey);

    function setUp() public {
        token = new Token(scheduler);
    }

    function testSchedulerCanMint() public {
        uint8[] memory mutations = new uint8[](1);
        mutations[0] = token.MINT();

        bytes[] memory mutationData = new bytes[](1);
        mutationData[0] = abi.encode(minter, uint256(100), uint256(0), uint256(1));

        Signature[] memory signatures = new Signature[](1);
        bytes32 structHash = keccak256(abi.encode(token.MINT_TYPEHASH(), minter, uint256(100), uint256(0), uint256(1)));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", token.domainSeparator(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(minterPrivateKey, digest);
        signatures[0] = Signature({keyType: 2, rawSignature: abi.encode(v, r, s)});

        Bundle[] memory bundles = new Bundle[](1);
        bundles[0] = Bundle({mutations: mutations, mutationData: mutationData, signatures: signatures});

        vm.prank(scheduler);
        token.execute(bundles, new uint256[](0));

        (uint256 nonce, uint256 balance) = token.accounts(minter);
        assertEq(token.totalSupply(), 100);
        assertEq(nonce, 1);
        assertEq(balance, 100);
    }
}
