// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {
    AUTHORIZATION_TYPEHASH,
    CREATE_ACCOUNT_MUTATION,
    EIP712_DOMAIN_TYPEHASH,
    Authorization,
    CreateAccount,
    InvalidNonce,
    InvalidSignature,
    KeyType,
    Typewriter
} from "typewriter/Typewriter.sol";
import {MintMutation} from "../src/Mint.sol";
import {Token} from "../src/Token.sol";
import {TransferMutation} from "../src/Transfer.sol";

contract TokenHarness is Token {
    constructor(address scheduler) Token(scheduler) {}

    function totalSupply() external view returns (uint256) {
        return state.totalSupply;
    }

    function balanceOf(bytes32 accountID) external view returns (uint256) {
        return state.balances[accountID];
    }

    function nonce(bytes32 accountID, uint192 lane) external view returns (uint64) {
        return accounts[accountID].nonces[lane];
    }
}

contract TokenTest is Test {
    uint256 internal constant USER_PRIVATE_KEY = 1;
    uint256 internal constant RECIPIENT_PRIVATE_KEY = 2;
    uint192 internal constant NONCE_LANE = 0x1234;

    TokenHarness internal token;
    bytes32 internal domainSeparator;
    bytes32 internal userAccountID;
    bytes32 internal recipientAccountID;

    function setUp() public {
        token = new TokenHarness(address(this));
        domainSeparator = keccak256(
            abi.encode(
                EIP712_DOMAIN_TYPEHASH,
                keccak256(bytes("Typewriter")),
                keccak256(bytes("1")),
                block.chainid,
                address(token)
            )
        );
        userAccountID = createAccount(USER_PRIVATE_KEY);
        recipientAccountID = createAccount(RECIPIENT_PRIVATE_KEY);
    }

    function testCreateMintTransferAndRejectReplay() public {
        uint256 mintNonce = uint256(NONCE_LANE) << 64;
        MintMutation.Mint memory mint = MintMutation.Mint({amount: 100});
        execute(
            uint8(Token.Mutation.Mint),
            abi.encode(mint),
            authorization(USER_PRIVATE_KEY, userAccountID, mintNonce, uint8(Token.Mutation.Mint), abi.encode(mint))
        );

        uint256 transferNonce = mintNonce + 1;
        TransferMutation.Transfer memory transfer = TransferMutation.Transfer({to: recipientAccountID, amount: 40});
        Authorization memory transferAuthorization = authorization(
            USER_PRIVATE_KEY, userAccountID, transferNonce, uint8(Token.Mutation.Transfer), abi.encode(transfer)
        );
        execute(uint8(Token.Mutation.Transfer), abi.encode(transfer), transferAuthorization);

        assertEq(token.totalSupply(), 100);
        assertEq(token.balanceOf(userAccountID), 60);
        assertEq(token.balanceOf(recipientAccountID), 40);
        assertEq(token.nonce(userAccountID, NONCE_LANE), 2);

        vm.expectRevert(abi.encodeWithSelector(InvalidNonce.selector, userAccountID, NONCE_LANE, uint64(2), uint64(1)));
        execute(uint8(Token.Mutation.Transfer), abi.encode(transfer), transferAuthorization);
    }

    function testRejectsAuthorizationForTamperedMutation() public {
        uint256 nonce = uint256(NONCE_LANE) << 64;
        MintMutation.Mint memory signedMint = MintMutation.Mint({amount: 100});
        Authorization memory signedAuthorization =
            authorization(USER_PRIVATE_KEY, userAccountID, nonce, uint8(Token.Mutation.Mint), abi.encode(signedMint));
        MintMutation.Mint memory tamperedMint = MintMutation.Mint({amount: 101});

        vm.expectRevert(abi.encodeWithSelector(InvalidSignature.selector, KeyType.Secp256k1));
        execute(uint8(Token.Mutation.Mint), abi.encode(tamperedMint), signedAuthorization);
    }

    function createAccount(uint256 privateKey) internal returns (bytes32 accountID) {
        bytes memory publicKey = abi.encode(vm.addr(privateKey));
        CreateAccount memory create = CreateAccount({keyType: KeyType.Secp256k1, publicKey: publicKey});
        accountID = keccak256(abi.encode(create.keyType, create.publicKey));
        bytes memory signature = sign(privateKey, accountID, 0, 0, CREATE_ACCOUNT_MUTATION, abi.encode(create));
        execute(
            CREATE_ACCOUNT_MUTATION,
            abi.encode(create),
            Authorization({accountID: accountID, credentialID: 0, nonce: 0, expiration: 0, signature: signature})
        );
    }

    function authorization(
        uint256 privateKey,
        bytes32 accountID,
        uint256 nonce,
        uint8 mutation,
        bytes memory mutationData
    ) internal view returns (Authorization memory) {
        return Authorization({
            accountID: accountID,
            credentialID: 0,
            nonce: nonce,
            expiration: 0,
            signature: sign(privateKey, accountID, 0, nonce, mutation, mutationData)
        });
    }

    function sign(
        uint256 privateKey,
        bytes32 accountID,
        uint64 credentialID,
        uint256 nonce,
        uint8 mutation,
        bytes memory mutationData
    ) internal view returns (bytes memory) {
        bytes32 structHash = keccak256(
            abi.encode(
                AUTHORIZATION_TYPEHASH, accountID, credentialID, nonce, uint256(0), mutation, keccak256(mutationData)
            )
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", domainSeparator, structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(privateKey, digest);
        return abi.encode(v, r, s);
    }

    function execute(uint8 mutation, bytes memory mutationData, Authorization memory auth) internal {
        Typewriter.Batch[] memory batches = new Typewriter.Batch[](1);
        batches[0].mutations = new uint8[](1);
        batches[0].mutationData = new bytes[](1);
        batches[0].authorizationData = new bytes[](1);
        batches[0].mutations[0] = mutation;
        batches[0].mutationData[0] = mutationData;
        batches[0].authorizationData[0] = abi.encode(auth);
        token.execute(batches, new uint256[](0));
    }
}
