// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";

import {
    Exchange,
    Batch,
    Mutation,
    Signature,
    Initialize,
    Authorize,
    Revoke,
    Deposit,
    Withdrawal,
    PERM_AUTHORIZE,
    PERM_REVOKE,
    PERM_DEPOSIT,
    PERM_WITHDRAW,
    PERM_LIMIT_ORDER,
    Unauthorized,
    AlreadyInitialized,
    InvalidAccount,
    KeyExpired,
    AUTHORIZE_TYPEHASH,
    REVOKE_TYPEHASH
} from "src/Exchange.sol";

import {KeyType} from "ffca/FFCA.sol";

contract AccountTest is Test, Exchange(address(0xBEEF)) {
    uint256 pk1 = 0xA11CE;
    uint256 pk2 = 0xB0B;
    uint256 p256Pk1 = 0xC0FFEE;
    uint256 p256Pk2 = 0xDECAF;
    bytes32 account;

    bytes32 constant _DEPOSIT_TYPEHASH =
        keccak256("Deposit(address asset,uint256 amount,uint256 nonce,uint256 deadline)");
    bytes32 constant _WITHDRAWAL_TYPEHASH =
        keccak256("Withdrawal(address asset,uint256 amount,uint256 nonce,uint256 deadline)");

    function setUp() public {
        account = keccak256(abi.encode(vm.addr(pk1)));
    }

    function _sign(uint256 pk, bytes32 structHash) internal view returns (bytes memory) {
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encode(v, r, s);
    }

    function _p256PublicKey(uint256 pk) internal pure returns (bytes memory) {
        (uint256 x, uint256 y) = vm.publicKeyP256(pk);
        return abi.encodePacked(uint8(0x04), x, y);
    }

    function _exec(Mutation[] memory mutations, bytes[] memory data, Signature[] memory sigs) internal {
        vm.prank(SCHEDULER);
        this.execute(_batches(mutations, data, sigs), new uint256[](0));
    }

    function _batches(Mutation[] memory mutations, bytes[] memory data, Signature[] memory sigs)
        internal
        pure
        returns (Batch[] memory batches)
    {
        batches = new Batch[](1);
        batches[0] = Batch({mutations: mutations, mutationData: data, signatures: sigs});
    }

    function _initAccount(uint256 rootPk, uint256 subPk, bytes32 acc, uint16 permissions) internal {
        Initialize memory init = Initialize({
            account: acc,
            expiry: 0,
            rootKeyType: uint8(KeyType.Secp256k1),
            keyType: uint8(KeyType.Secp256k1),
            permissions: permissions,
            rootPublicKey: abi.encode(vm.addr(rootPk)),
            publicKey: abi.encode(vm.addr(subPk))
        });

        Mutation[] memory muts = new Mutation[](1);
        bytes[] memory data = new bytes[](1);
        Signature[] memory sigs = new Signature[](1);

        muts[0] = Mutation.Initialize;
        data[0] = abi.encode(init);
        sigs[0] = Signature({account: acc, keyId: 0, rawSignature: ""});

        _exec(muts, data, sigs);
    }

    function test_Initialize() external {
        _initAccount(pk1, pk2, account, PERM_DEPOSIT);

        assertEq(state.accounts[account].keys.length, 2);
        assertEq(uint8(state.accounts[account].keys[0].keyType), uint8(KeyType.Secp256k1));
        assertEq(state.accounts[account].keys[0].permissions, type(uint16).max);
        assertEq(state.accounts[account].keys[1].permissions, PERM_DEPOSIT);
        assertEq(state.accounts[account].nonces[0], 0);
    }

    function test_Initialize_RejectsAccountNotMatchingRootKey() external {
        bytes32 mismatchedAccount = bytes32(uint256(0xDEADBEEF));
        Initialize memory init = Initialize({
            account: mismatchedAccount,
            expiry: 0,
            rootKeyType: uint8(KeyType.Secp256k1),
            keyType: uint8(KeyType.Secp256k1),
            permissions: PERM_DEPOSIT,
            rootPublicKey: abi.encode(vm.addr(pk1)),
            publicKey: abi.encode(vm.addr(pk2))
        });

        Mutation[] memory muts = new Mutation[](1);
        bytes[] memory data = new bytes[](1);
        Signature[] memory sigs = new Signature[](1);

        muts[0] = Mutation.Initialize;
        data[0] = abi.encode(init);
        sigs[0] = Signature({account: mismatchedAccount, keyId: 0, rawSignature: ""});

        vm.prank(SCHEDULER);
        vm.expectRevert(InvalidAccount.selector);
        this.execute(_batches(muts, data, sigs), new uint256[](0));
    }

    function test_Initialize_AlreadyInitialized() external {
        _initAccount(pk1, pk2, account, PERM_DEPOSIT);

        Initialize memory init = Initialize({
            account: account,
            expiry: 0,
            rootKeyType: uint8(KeyType.Secp256k1),
            keyType: uint8(KeyType.Secp256k1),
            permissions: PERM_DEPOSIT,
            rootPublicKey: abi.encode(vm.addr(pk1)),
            publicKey: abi.encode(vm.addr(pk2))
        });

        Mutation[] memory muts = new Mutation[](1);
        bytes[] memory data = new bytes[](1);
        Signature[] memory sigs = new Signature[](1);

        muts[0] = Mutation.Initialize;
        data[0] = abi.encode(init);
        sigs[0] = Signature({account: account, keyId: 0, rawSignature: ""});

        vm.prank(SCHEDULER);
        vm.expectRevert(AlreadyInitialized.selector);
        this.execute(_batches(muts, data, sigs), new uint256[](0));
    }

    function test_Authorize() external {
        _initAccount(pk1, pk2, account, PERM_DEPOSIT);

        uint256 pk3 = 0xCAFE;
        Authorize memory auth = Authorize({
            account: account,
            expiry: 0,
            keyType: uint8(KeyType.Secp256k1),
            permissions: PERM_DEPOSIT,
            publicKey: abi.encode(vm.addr(pk3)),
            nonce: 0,
            deadline: type(uint256).max
        });

        Mutation[] memory muts = new Mutation[](1);
        bytes[] memory data = new bytes[](1);
        Signature[] memory sigs = new Signature[](1);

        muts[0] = Mutation.Authorize;
        data[0] = abi.encode(auth);
        sigs[0] = Signature({
            account: account,
            keyId: 0,
            rawSignature: _sign(
                pk1,
                keccak256(
                    abi.encode(
                        AUTHORIZE_TYPEHASH,
                        auth.account,
                        auth.expiry,
                        auth.keyType,
                        auth.permissions,
                        keccak256(auth.publicKey),
                        auth.nonce,
                        auth.deadline
                    )
                )
            )
        });

        _exec(muts, data, sigs);

        assertEq(state.accounts[account].keys.length, 3);
        assertEq(state.accounts[account].keys[2].permissions, PERM_DEPOSIT);
        assertEq(state.accounts[account].nonces[0], 1);
    }

    function test_Authorize_Unauthorized() external {
        _initAccount(pk1, pk2, account, PERM_DEPOSIT);

        uint256 pk3 = 0xCAFE;
        Authorize memory auth = Authorize({
            account: account,
            expiry: 0,
            keyType: uint8(KeyType.Secp256k1),
            permissions: PERM_DEPOSIT,
            publicKey: abi.encode(vm.addr(pk3)),
            nonce: 0,
            deadline: type(uint256).max
        });

        Mutation[] memory muts = new Mutation[](1);
        bytes[] memory data = new bytes[](1);
        Signature[] memory sigs = new Signature[](1);

        muts[0] = Mutation.Authorize;
        data[0] = abi.encode(auth);
        sigs[0] = Signature({
            account: account,
            keyId: 1,
            rawSignature: _sign(
                pk2,
                keccak256(
                    abi.encode(
                        AUTHORIZE_TYPEHASH,
                        auth.account,
                        auth.expiry,
                        auth.keyType,
                        auth.permissions,
                        keccak256(auth.publicKey),
                        auth.nonce,
                        auth.deadline
                    )
                )
            )
        });

        vm.prank(SCHEDULER);
        vm.expectRevert(Unauthorized.selector);
        this.execute(_batches(muts, data, sigs), new uint256[](0));
    }

    function test_Revoke() external {
        _initAccount(pk1, pk2, account, PERM_DEPOSIT);

        Revoke memory rev = Revoke({account: account, keyId: 1, nonce: 0, deadline: type(uint256).max});

        Mutation[] memory muts = new Mutation[](1);
        bytes[] memory data = new bytes[](1);
        Signature[] memory sigs = new Signature[](1);

        muts[0] = Mutation.Revoke;
        data[0] = abi.encode(rev);
        sigs[0] = Signature({
            account: account,
            keyId: 0,
            rawSignature: _sign(
                pk1, keccak256(abi.encode(REVOKE_TYPEHASH, rev.account, rev.keyId, rev.nonce, rev.deadline))
            )
        });

        _exec(muts, data, sigs);

        assertEq(state.accounts[account].keys[1].permissions, 0);
    }

    function test_KeyExpiry() external {
        Initialize memory init = Initialize({
            account: account,
            expiry: uint40(block.timestamp + 100),
            rootKeyType: uint8(KeyType.Secp256k1),
            keyType: uint8(KeyType.Secp256k1),
            permissions: type(uint16).max,
            rootPublicKey: abi.encode(vm.addr(pk1)),
            publicKey: abi.encode(vm.addr(pk2))
        });

        Mutation[] memory muts = new Mutation[](1);
        bytes[] memory data = new bytes[](1);
        Signature[] memory sigs = new Signature[](1);

        muts[0] = Mutation.Initialize;
        data[0] = abi.encode(init);
        sigs[0] = Signature({account: account, keyId: 0, rawSignature: ""});

        _exec(muts, data, sigs);

        vm.warp(block.timestamp + 101);

        Deposit memory d = Deposit({asset: address(1), amount: 100, nonce: 0, deadline: type(uint256).max});

        muts[0] = Mutation.Deposit;
        data[0] = abi.encode(d);
        sigs[0] = Signature({
            account: account,
            keyId: 1,
            rawSignature: _sign(pk2, keccak256(abi.encode(_DEPOSIT_TYPEHASH, d.asset, d.amount, d.nonce, d.deadline)))
        });

        vm.prank(SCHEDULER);
        vm.expectRevert(KeyExpired.selector);
        this.execute(_batches(muts, data, sigs), new uint256[](0));
    }

    function test_PermissionEnforcement() external {
        _initAccount(pk1, pk2, account, PERM_DEPOSIT);

        Withdrawal memory w = Withdrawal({asset: address(1), amount: 100, nonce: 0, deadline: type(uint256).max});

        Mutation[] memory muts = new Mutation[](1);
        bytes[] memory data = new bytes[](1);
        Signature[] memory sigs = new Signature[](1);

        muts[0] = Mutation.Withdrawal;
        data[0] = abi.encode(w);
        sigs[0] = Signature({
            account: account,
            keyId: 1,
            rawSignature: _sign(
                pk2, keccak256(abi.encode(_WITHDRAWAL_TYPEHASH, w.asset, w.amount, w.nonce, w.deadline))
            )
        });

        vm.prank(SCHEDULER);
        vm.expectRevert(Unauthorized.selector);
        this.execute(_batches(muts, data, sigs), new uint256[](0));
    }

    function test_Initialize_P256RootKey() external {
        bytes32 p256Account = keccak256(_p256PublicKey(p256Pk1));
        Initialize memory init = Initialize({
            account: p256Account,
            expiry: 0,
            rootKeyType: uint8(KeyType.P256),
            keyType: uint8(KeyType.P256),
            permissions: 0x1ff,
            rootPublicKey: _p256PublicKey(p256Pk1),
            publicKey: _p256PublicKey(p256Pk2)
        });

        Mutation[] memory muts = new Mutation[](1);
        bytes[] memory data = new bytes[](1);
        Signature[] memory sigs = new Signature[](1);

        muts[0] = Mutation.Initialize;
        data[0] = abi.encode(init);
        sigs[0] = Signature({account: p256Account, keyId: 0, rawSignature: ""});

        _exec(muts, data, sigs);

        assertEq(state.accounts[p256Account].keys.length, 2);
        assertEq(uint8(state.accounts[p256Account].keys[0].keyType), uint8(KeyType.P256));
        assertEq(state.accounts[p256Account].keys[0].permissions, type(uint16).max);
        assertEq(uint8(state.accounts[p256Account].keys[1].keyType), uint8(KeyType.P256));
        assertEq(state.accounts[p256Account].keys[1].permissions, 0x1ff);
    }
}
