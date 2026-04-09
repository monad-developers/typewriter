// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";

import {
    Exchange,
    ExecuteParams,
    Mutation,
    Signature,
    Deposit,
    PERM_AUTHORIZE,
    PERM_REVOKE,
    PERM_DEPOSIT,
    PERM_WITHDRAW,
    PERM_LIMIT_ORDER,
    Withdrawal,
    Unauthorized,
    AlreadyInitialized,
    MissingAuthorizePermission
} from "src/Exchange.sol";

import {
    KeyType,
    Key,
    Initialize,
    Authorize,
    Revoke,
    KeyNotFound,
    KeyExpired,
    INITIALIZE_TYPEHASH,
    AUTHORIZE_TYPEHASH,
    REVOKE_TYPEHASH
} from "src/Account.sol";

contract AccountTest is Test, Exchange(address(0xBEEF)) {
    uint256 pk1 = 0xA11CE;
    uint256 pk2 = 0xB0B;
    bytes32 account;

    bytes32 constant _DEPOSIT_TYPEHASH =
        keccak256("Deposit(address asset,uint256 amount,uint256 nonce,uint256 deadline)");

    function setUp() public {
        account = bytes32(uint256(uint160(vm.addr(pk1))));
    }

    function _sign(uint256 pk, bytes32 structHash) internal view returns (bytes memory) {
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encode(v, r, s);
    }

    function _exec(Mutation[] memory mutations, bytes[] memory data, Signature[] memory sigs) internal {
        vm.prank(SCHEDULER);
        this.execute(ExecuteParams({mutations: mutations, mutationData: data, signatures: sigs}));
    }

    function _initAccount(uint256 pk, bytes32 acc, uint8 permissions) internal {
        Initialize memory init = Initialize({
            account: acc,
            expiry: 0,
            keyType: uint8(KeyType.Secp256k1),
            permissions: permissions,
            publicKey: abi.encode(vm.addr(pk))
        });

        Mutation[] memory muts = new Mutation[](1);
        bytes[] memory data = new bytes[](1);
        Signature[] memory sigs = new Signature[](1);

        muts[0] = Mutation.Initialize;
        data[0] = abi.encode(init);
        sigs[0] = Signature({
            account: acc,
            keyId: 0,
            rawSignature: _sign(
                pk,
                keccak256(
                    abi.encode(
                        INITIALIZE_TYPEHASH, init.account, init.expiry, init.keyType, init.permissions,
                        keccak256(init.publicKey)
                    )
                )
            )
        });

        _exec(muts, data, sigs);
    }

    function test_Initialize() external {
        _initAccount(pk1, account, PERM_AUTHORIZE | PERM_DEPOSIT);

        assertEq(state.accounts[account].keys.length, 1);
        assertEq(uint8(state.accounts[account].keys[0].keyType), uint8(KeyType.Secp256k1));
        assertEq(state.accounts[account].keys[0].permissions, PERM_AUTHORIZE | PERM_DEPOSIT);
        assertEq(state.accounts[account].nonces[0], 0);
    }

    function test_Initialize_AlreadyInitialized() external {
        _initAccount(pk1, account, PERM_AUTHORIZE);

        Initialize memory init = Initialize({
            account: account,
            expiry: 0,
            keyType: uint8(KeyType.Secp256k1),
            permissions: PERM_AUTHORIZE,
            publicKey: abi.encode(vm.addr(pk1))
        });

        Mutation[] memory muts = new Mutation[](1);
        bytes[] memory data = new bytes[](1);
        Signature[] memory sigs = new Signature[](1);

        muts[0] = Mutation.Initialize;
        data[0] = abi.encode(init);
        sigs[0] = Signature({
            account: account,
            keyId: 0,
            rawSignature: _sign(
                pk1,
                keccak256(
                    abi.encode(
                        INITIALIZE_TYPEHASH, init.account, init.expiry, init.keyType, init.permissions,
                        keccak256(init.publicKey)
                    )
                )
            )
        });

        vm.prank(SCHEDULER);
        vm.expectRevert(AlreadyInitialized.selector);
        this.execute(ExecuteParams({mutations: muts, mutationData: data, signatures: sigs}));
    }

    function test_Initialize_MissingAuthorizePermission() external {
        Initialize memory init = Initialize({
            account: account,
            expiry: 0,
            keyType: uint8(KeyType.Secp256k1),
            permissions: PERM_DEPOSIT,
            publicKey: abi.encode(vm.addr(pk1))
        });

        Mutation[] memory muts = new Mutation[](1);
        bytes[] memory data = new bytes[](1);
        Signature[] memory sigs = new Signature[](1);

        muts[0] = Mutation.Initialize;
        data[0] = abi.encode(init);
        sigs[0] = Signature({
            account: account,
            keyId: 0,
            rawSignature: _sign(
                pk1,
                keccak256(
                    abi.encode(
                        INITIALIZE_TYPEHASH, init.account, init.expiry, init.keyType, init.permissions,
                        keccak256(init.publicKey)
                    )
                )
            )
        });

        vm.prank(SCHEDULER);
        vm.expectRevert(MissingAuthorizePermission.selector);
        this.execute(ExecuteParams({mutations: muts, mutationData: data, signatures: sigs}));
    }

    function test_Authorize() external {
        _initAccount(pk1, account, type(uint8).max);

        Authorize memory auth = Authorize({
            account: account,
            expiry: 0,
            keyType: uint8(KeyType.Secp256k1),
            permissions: PERM_DEPOSIT,
            publicKey: abi.encode(vm.addr(pk2)),
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
                        AUTHORIZE_TYPEHASH, auth.account, auth.expiry, auth.keyType, auth.permissions,
                        keccak256(auth.publicKey), auth.nonce, auth.deadline
                    )
                )
            )
        });

        _exec(muts, data, sigs);

        assertEq(state.accounts[account].keys.length, 2);
        assertEq(state.accounts[account].keys[1].permissions, PERM_DEPOSIT);
        assertEq(state.accounts[account].nonces[0], 1);
    }

    function test_Authorize_Unauthorized() external {
        _initAccount(pk1, account, type(uint8).max);

        // Add pk2 as a key with only PERM_DEPOSIT (no PERM_AUTHORIZE)
        {
            Authorize memory addKey = Authorize({
                account: account,
                expiry: 0,
                keyType: uint8(KeyType.Secp256k1),
                permissions: PERM_DEPOSIT,
                publicKey: abi.encode(vm.addr(pk2)),
                nonce: 0,
                deadline: type(uint256).max
            });

            Mutation[] memory m = new Mutation[](1);
            bytes[] memory d = new bytes[](1);
            Signature[] memory s = new Signature[](1);

            m[0] = Mutation.Authorize;
            d[0] = abi.encode(addKey);
            s[0] = Signature({
                account: account,
                keyId: 0,
                rawSignature: _sign(
                    pk1,
                    keccak256(
                        abi.encode(
                            AUTHORIZE_TYPEHASH, addKey.account, addKey.expiry, addKey.keyType, addKey.permissions,
                            keccak256(addKey.publicKey), addKey.nonce, addKey.deadline
                        )
                    )
                )
            });

            _exec(m, d, s);
        }

        // Try to authorize a third key using pk2 (keyId: 1, no PERM_AUTHORIZE)
        Authorize memory auth = Authorize({
            account: account,
            expiry: 0,
            keyType: uint8(KeyType.Secp256k1),
            permissions: PERM_DEPOSIT,
            publicKey: abi.encode(address(0xDEAD)),
            nonce: 1,
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
                        AUTHORIZE_TYPEHASH, auth.account, auth.expiry, auth.keyType, auth.permissions,
                        keccak256(auth.publicKey), auth.nonce, auth.deadline
                    )
                )
            )
        });

        vm.prank(SCHEDULER);
        vm.expectRevert(Unauthorized.selector);
        this.execute(ExecuteParams({mutations: muts, mutationData: data, signatures: sigs}));
    }

    function test_Revoke() external {
        _initAccount(pk1, account, type(uint8).max);

        Authorize memory auth = Authorize({
            account: account,
            expiry: 0,
            keyType: uint8(KeyType.Secp256k1),
            permissions: PERM_DEPOSIT,
            publicKey: abi.encode(vm.addr(pk2)),
            nonce: 0,
            deadline: type(uint256).max
        });

        {
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
                            AUTHORIZE_TYPEHASH, auth.account, auth.expiry, auth.keyType, auth.permissions,
                            keccak256(auth.publicKey), auth.nonce, auth.deadline
                        )
                    )
                )
            });

            _exec(muts, data, sigs);
        }

        assertEq(state.accounts[account].keys.length, 2);

        Revoke memory rev = Revoke({account: account, keyId: 1, nonce: 1, deadline: type(uint256).max});

        Mutation[] memory muts = new Mutation[](1);
        bytes[] memory data = new bytes[](1);
        Signature[] memory sigs = new Signature[](1);

        muts[0] = Mutation.Revoke;
        data[0] = abi.encode(rev);
        sigs[0] = Signature({
            account: account,
            keyId: 0,
            rawSignature: _sign(
                pk1,
                keccak256(abi.encode(REVOKE_TYPEHASH, rev.account, rev.keyId, rev.nonce, rev.deadline))
            )
        });

        _exec(muts, data, sigs);

        assertEq(state.accounts[account].keys[1].permissions, 0);
    }

    function test_KeyExpiry() external {
        Initialize memory init = Initialize({
            account: account,
            expiry: uint40(block.timestamp + 100),
            keyType: uint8(KeyType.Secp256k1),
            permissions: type(uint8).max,
            publicKey: abi.encode(vm.addr(pk1))
        });

        Mutation[] memory muts = new Mutation[](1);
        bytes[] memory data = new bytes[](1);
        Signature[] memory sigs = new Signature[](1);

        muts[0] = Mutation.Initialize;
        data[0] = abi.encode(init);
        sigs[0] = Signature({
            account: account,
            keyId: 0,
            rawSignature: _sign(
                pk1,
                keccak256(
                    abi.encode(
                        INITIALIZE_TYPEHASH, init.account, init.expiry, init.keyType, init.permissions,
                        keccak256(init.publicKey)
                    )
                )
            )
        });

        _exec(muts, data, sigs);

        vm.warp(block.timestamp + 101);

        Deposit memory d = Deposit({asset: address(1), amount: 100, nonce: 0, deadline: type(uint256).max});

        muts[0] = Mutation.Deposit;
        data[0] = abi.encode(d);
        sigs[0] = Signature({
            account: account,
            keyId: 0,
            rawSignature: _sign(pk1, keccak256(abi.encode(_DEPOSIT_TYPEHASH, d.asset, d.amount, d.nonce, d.deadline)))
        });

        vm.prank(SCHEDULER);
        vm.expectRevert(KeyExpired.selector);
        this.execute(ExecuteParams({mutations: muts, mutationData: data, signatures: sigs}));
    }

    bytes32 constant _WITHDRAWAL_TYPEHASH =
        keccak256("Withdrawal(address asset,uint256 amount,uint256 nonce,uint256 deadline)");

    function test_PermissionEnforcement() external {

        _initAccount(pk1, account, PERM_AUTHORIZE | PERM_DEPOSIT);

        Withdrawal memory w = Withdrawal({asset: address(1), amount: 100, nonce: 0, deadline: type(uint256).max});

        Mutation[] memory muts = new Mutation[](1);
        bytes[] memory data = new bytes[](1);
        Signature[] memory sigs = new Signature[](1);

        muts[0] = Mutation.Withdrawal;
        data[0] = abi.encode(w);
        sigs[0] = Signature({
            account: account,
            keyId: 0,
            rawSignature: _sign(
                pk1, keccak256(abi.encode(_WITHDRAWAL_TYPEHASH, w.asset, w.amount, w.nonce, w.deadline))
            )
        });

        vm.prank(SCHEDULER);
        vm.expectRevert(Unauthorized.selector);
        this.execute(ExecuteParams({mutations: muts, mutationData: data, signatures: sigs}));
    }
}
