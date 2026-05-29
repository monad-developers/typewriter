// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {EIP712_DOMAIN_TYPEHASH} from "ffca/FFCA.sol";
import {MintMutation} from "../src/Mint.sol";
import {InvalidNonce, InvalidSignatureType, Signature, SignatureExpired, State} from "../src/Token.sol";
import {TransferMutation} from "../src/Transfer.sol";

contract TokenTest is Test {
    State internal state;
    bytes32 internal domainSeparator;
    uint256 internal userPrivateKey = 1;
    address internal user = vm.addr(userPrivateKey);
    address internal recipient = address(0xBEEF);

    function setUp() public {
        domainSeparator = keccak256(
            abi.encode(
                EIP712_DOMAIN_TYPEHASH, keccak256(bytes("Token")), keccak256(bytes("1")), block.chainid, address(this)
            )
        );
    }

    function testMintSignatureAndExecution() public {
        MintMutation.Mint memory mint = MintMutation.Mint({to: user, amount: 100, nonce: 0, deadline: 1});
        Signature memory signature = sign(userPrivateKey, MintMutation.hashMint(mint));

        MintMutation.verifyMintSignature(state, mint, signature, digest(MintMutation.hashMint(mint)));
        MintMutation.executeMint(state, mint);

        assertEq(state.totalSupply, 100);
        assertEq(state.accounts[user].nonce, 1);
        assertEq(state.accounts[user].balance, 100);
    }

    function testTransferSignatureAndExecution() public {
        state.accounts[user].nonce = 1;
        state.accounts[user].balance = 100;
        TransferMutation.Transfer memory transfer =
            TransferMutation.Transfer({from: user, to: recipient, amount: 40, nonce: 1, deadline: 1});
        Signature memory signature = sign(userPrivateKey, TransferMutation.hashTransfer(transfer));

        TransferMutation.verifyTransferSignature(
            state, transfer, signature, digest(TransferMutation.hashTransfer(transfer))
        );
        TransferMutation.executeTransfer(state, transfer);

        assertEq(state.accounts[user].nonce, 2);
        assertEq(state.accounts[user].balance, 60);
        assertEq(state.accounts[recipient].balance, 40);
    }

    function testVerifierRejectsInvalidNonce() public {
        MintMutation.Mint memory mint = MintMutation.Mint({to: user, amount: 100, nonce: 1, deadline: 1});
        Signature memory signature = sign(userPrivateKey, MintMutation.hashMint(mint));

        vm.expectRevert(InvalidNonce.selector);
        this.verifyMint(mint, signature);
    }

    function testVerifierRejectsExpiredSignature() public {
        vm.warp(100);
        MintMutation.Mint memory mint = MintMutation.Mint({to: user, amount: 100, nonce: 0, deadline: 99});
        Signature memory signature = sign(userPrivateKey, MintMutation.hashMint(mint));

        vm.expectRevert(SignatureExpired.selector);
        this.verifyMint(mint, signature);
    }

    function testVerifierRejectsUnsupportedSignatureType() public {
        MintMutation.Mint memory mint = MintMutation.Mint({to: user, amount: 100, nonce: 0, deadline: 1});
        Signature memory signature = sign(userPrivateKey, MintMutation.hashMint(mint));
        signature.keyType = 0;

        vm.expectRevert(InvalidSignatureType.selector);
        this.verifyMint(mint, signature);
    }

    function verifyMint(MintMutation.Mint memory mint, Signature memory signature) external {
        MintMutation.verifyMintSignature(state, mint, signature, digest(MintMutation.hashMint(mint)));
    }

    function digest(bytes32 structHash) internal view returns (bytes32) {
        return keccak256(abi.encodePacked("\x19\x01", domainSeparator, structHash));
    }

    function sign(uint256 privateKey, bytes32 structHash) internal view returns (Signature memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(privateKey, digest(structHash));
        return Signature({keyType: 2, rawSignature: abi.encode(v, r, s)});
    }
}
