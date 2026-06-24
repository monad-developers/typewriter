// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";

import {
    AlreadyInitialized,
    InstrumentAlreadyExists,
    InvalidAccount,
    InvalidNonce,
    KeyExpired,
    KeyNotFound,
    LotExpTooLarge,
    PERM_AUTHORIZE,
    PERM_DEPOSIT,
    PERM_REVOKE,
    PERM_WITHDRAW,
    Signature,
    SignatureExpired,
    State,
    Unauthorized
} from "src/OrderBook.sol";
import {AddInstrumentMutation} from "src/AddInstrument.sol";
import {AuthorizeMutation} from "src/Authorize.sol";
import {DepositMutation} from "src/Deposit.sol";
import {InitializeMutation} from "src/Initialize.sol";
import {RevokeMutation} from "src/Revoke.sol";
import {WithdrawalMutation} from "src/Withdrawal.sol";

import {EIP712_DOMAIN_TYPEHASH, KeyType} from "typewriter/Typewriter.sol";

contract AccountTest is Test {
    State internal state;
    bytes32 internal DOMAIN_SEPARATOR;

    uint256 pk1 = 0xA11CE;
    uint256 pk2 = 0xB0B;
    uint256 p256Pk1 = 0xC0FFEE;
    uint256 p256Pk2 = 0xDECAF;
    bytes32 account;

    function setUp() public {
        DOMAIN_SEPARATOR = keccak256(
            abi.encode(
                EIP712_DOMAIN_TYPEHASH,
                keccak256(bytes("Typewriter")),
                keccak256(bytes("1")),
                block.chainid,
                address(this)
            )
        );
        account = keccak256(abi.encode(vm.addr(pk1)));
    }

    function _sign(uint256 pk, bytes32 structHash) internal view returns (bytes memory) {
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR, structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encode(v, r, s);
    }

    function _p256PublicKey(uint256 pk) internal pure returns (bytes memory) {
        (uint256 x, uint256 y) = vm.publicKeyP256(pk);
        return abi.encodePacked(uint8(0x04), x, y);
    }

    function _initAccount(uint256 rootPk, uint256 subPk, bytes32 acc, uint16 permissions) internal {
        InitializeMutation.Initialize memory init = InitializeMutation.Initialize({
            account: acc,
            expiry: 0,
            rootKeyType: uint8(KeyType.Secp256k1),
            keyType: uint8(KeyType.Secp256k1),
            permissions: permissions,
            rootPublicKey: abi.encode(vm.addr(rootPk)),
            publicKey: abi.encode(vm.addr(subPk))
        });

        InitializeMutation.executeInitialize(state, init, Signature({account: acc, keyId: 0, rawSignature: ""}));
    }

    function _signature(bytes32 acc, uint64 keyId, uint256 pk, bytes32 structHash)
        internal
        view
        returns (Signature memory)
    {
        return Signature({account: acc, keyId: keyId, rawSignature: _sign(pk, structHash)});
    }

    function callExecuteInitialize(InitializeMutation.Initialize memory init, Signature memory sig) external {
        InitializeMutation.executeInitialize(state, init, sig);
    }

    function callVerifyAuthorize(AuthorizeMutation.Authorize memory auth, Signature memory sig) external {
        AuthorizeMutation.verifyAuthorizeSignature(state, auth, sig, _digest(AuthorizeMutation.hashAuthorize(auth)));
    }

    function callVerifyDeposit(DepositMutation.Deposit memory deposit, Signature memory sig) external {
        DepositMutation.verifyDepositSignature(state, deposit, sig, _digest(DepositMutation.hashDeposit(deposit)));
    }

    function callVerifyWithdrawal(WithdrawalMutation.Withdrawal memory withdrawal, Signature memory sig) external {
        WithdrawalMutation.verifyWithdrawalSignature(
            state, withdrawal, sig, _digest(WithdrawalMutation.hashWithdrawal(withdrawal))
        );
    }

    function callExecuteAddInstrument(AddInstrumentMutation.AddInstrument memory instrument) external {
        AddInstrumentMutation.executeAddInstrument(state, instrument);
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
        InitializeMutation.Initialize memory init = InitializeMutation.Initialize({
            account: mismatchedAccount,
            expiry: 0,
            rootKeyType: uint8(KeyType.Secp256k1),
            keyType: uint8(KeyType.Secp256k1),
            permissions: PERM_DEPOSIT,
            rootPublicKey: abi.encode(vm.addr(pk1)),
            publicKey: abi.encode(vm.addr(pk2))
        });

        vm.expectRevert(InvalidAccount.selector);
        this.callExecuteInitialize(init, Signature({account: mismatchedAccount, keyId: 0, rawSignature: ""}));
    }

    function test_Initialize_AlreadyInitialized() external {
        _initAccount(pk1, pk2, account, PERM_DEPOSIT);

        InitializeMutation.Initialize memory init = InitializeMutation.Initialize({
            account: account,
            expiry: 0,
            rootKeyType: uint8(KeyType.Secp256k1),
            keyType: uint8(KeyType.Secp256k1),
            permissions: PERM_DEPOSIT,
            rootPublicKey: abi.encode(vm.addr(pk1)),
            publicKey: abi.encode(vm.addr(pk2))
        });

        vm.expectRevert(AlreadyInitialized.selector);
        this.callExecuteInitialize(init, Signature({account: account, keyId: 0, rawSignature: ""}));
    }

    function test_Authorize() external {
        _initAccount(pk1, pk2, account, PERM_DEPOSIT);

        uint256 pk3 = 0xCAFE;
        AuthorizeMutation.Authorize memory auth = AuthorizeMutation.Authorize({
            account: account,
            expiry: 0,
            keyType: uint8(KeyType.Secp256k1),
            permissions: PERM_DEPOSIT,
            publicKey: abi.encode(vm.addr(pk3)),
            nonce: 0,
            deadline: type(uint256).max
        });
        Signature memory sig = _signature(account, 0, pk1, AuthorizeMutation.hashAuthorize(auth));

        AuthorizeMutation.verifyAuthorizeSignature(state, auth, sig, _digest(AuthorizeMutation.hashAuthorize(auth)));
        AuthorizeMutation.executeAuthorize(state, auth, sig);

        assertEq(state.accounts[account].keys.length, 3);
        assertEq(state.accounts[account].keys[2].permissions, PERM_DEPOSIT);
        assertEq(state.accounts[account].nonces[0], 1);
    }

    function test_Authorize_Unauthorized() external {
        _initAccount(pk1, pk2, account, PERM_DEPOSIT);

        uint256 pk3 = 0xCAFE;
        AuthorizeMutation.Authorize memory auth = AuthorizeMutation.Authorize({
            account: account,
            expiry: 0,
            keyType: uint8(KeyType.Secp256k1),
            permissions: PERM_DEPOSIT,
            publicKey: abi.encode(vm.addr(pk3)),
            nonce: 0,
            deadline: type(uint256).max
        });
        Signature memory sig = _signature(account, 1, pk2, AuthorizeMutation.hashAuthorize(auth));

        vm.expectRevert(Unauthorized.selector);
        this.callVerifyAuthorize(auth, sig);
    }

    function test_Revoke() external {
        _initAccount(pk1, pk2, account, PERM_REVOKE);

        RevokeMutation.Revoke memory rev =
            RevokeMutation.Revoke({account: account, keyId: 1, nonce: 0, deadline: type(uint256).max});
        Signature memory sig = _signature(account, 0, pk1, RevokeMutation.hashRevoke(rev));

        RevokeMutation.verifyRevokeSignature(state, rev, sig, _digest(RevokeMutation.hashRevoke(rev)));
        RevokeMutation.executeRevoke(state, rev, sig);

        assertEq(state.accounts[account].keys[1].permissions, 0);
    }

    function test_Deposit() external {
        _initAccount(pk1, pk2, account, PERM_DEPOSIT);

        DepositMutation.Deposit memory deposit =
            DepositMutation.Deposit({asset: address(1), amount: 500, nonce: 0, deadline: type(uint256).max});
        Signature memory sig = _signature(account, 1, pk2, DepositMutation.hashDeposit(deposit));

        DepositMutation.verifyDepositSignature(state, deposit, sig, _digest(DepositMutation.hashDeposit(deposit)));
        DepositMutation.executeDeposit(state, deposit, sig);

        assertEq(state.accounts[account].balances[address(1)], 500);
        assertEq(state.accounts[account].nonces[0], 1);
    }

    function test_Withdrawal() external {
        _initAccount(pk1, pk2, account, PERM_WITHDRAW);
        state.accounts[account].balances[address(1)] = 500;

        WithdrawalMutation.Withdrawal memory withdrawal =
            WithdrawalMutation.Withdrawal({asset: address(1), amount: 200, nonce: 0, deadline: type(uint256).max});
        Signature memory sig = _signature(account, 1, pk2, WithdrawalMutation.hashWithdrawal(withdrawal));

        WithdrawalMutation.verifyWithdrawalSignature(
            state, withdrawal, sig, _digest(WithdrawalMutation.hashWithdrawal(withdrawal))
        );
        WithdrawalMutation.executeWithdrawal(state, withdrawal, sig);

        assertEq(state.accounts[account].balances[address(1)], 300);
        assertEq(state.accounts[account].nonces[0], 1);
    }

    function test_AddInstrument() external {
        _initAccount(pk1, pk2, account, PERM_AUTHORIZE | PERM_DEPOSIT | PERM_WITHDRAW | PERM_REVOKE | (1 << 7));

        AddInstrumentMutation.AddInstrument memory instrument = AddInstrumentMutation.AddInstrument({
            instrumentId: 7,
            base: address(1),
            quote: address(2),
            baseLotExp: 8,
            quoteLotExp: 9,
            nonce: 0,
            deadline: type(uint256).max
        });
        Signature memory sig = _signature(account, 1, pk2, AddInstrumentMutation.hashAddInstrument(instrument));

        AddInstrumentMutation.verifyAddInstrumentSignature(
            state, instrument, sig, _digest(AddInstrumentMutation.hashAddInstrument(instrument))
        );
        AddInstrumentMutation.executeAddInstrument(state, instrument);

        assertEq(state.instruments[7].base, address(1));
        assertEq(state.instruments[7].quote, address(2));
        assertEq(state.instruments[7].baseLotExp, 8);
        assertEq(state.instruments[7].quoteLotExp, 9);
    }

    function test_AddInstrument_LotExpTooLarge() external {
        AddInstrumentMutation.AddInstrument memory instrument = AddInstrumentMutation.AddInstrument({
            instrumentId: 7,
            base: address(1),
            quote: address(2),
            baseLotExp: 129,
            quoteLotExp: 0,
            nonce: 0,
            deadline: type(uint256).max
        });

        vm.expectRevert(LotExpTooLarge.selector);
        this.callExecuteAddInstrument(instrument);
    }

    function test_AddInstrument_AlreadyExists() external {
        AddInstrumentMutation.AddInstrument memory instrument = AddInstrumentMutation.AddInstrument({
            instrumentId: 7,
            base: address(1),
            quote: address(2),
            baseLotExp: 0,
            quoteLotExp: 0,
            nonce: 0,
            deadline: type(uint256).max
        });
        AddInstrumentMutation.executeAddInstrument(state, instrument);

        vm.expectRevert(InstrumentAlreadyExists.selector);
        this.callExecuteAddInstrument(instrument);
    }

    function test_KeyExpiry() external {
        InitializeMutation.Initialize memory init = InitializeMutation.Initialize({
            account: account,
            expiry: uint40(block.timestamp + 100),
            rootKeyType: uint8(KeyType.Secp256k1),
            keyType: uint8(KeyType.Secp256k1),
            permissions: PERM_DEPOSIT,
            rootPublicKey: abi.encode(vm.addr(pk1)),
            publicKey: abi.encode(vm.addr(pk2))
        });
        InitializeMutation.executeInitialize(state, init, Signature({account: account, keyId: 0, rawSignature: ""}));

        vm.warp(block.timestamp + 101);

        DepositMutation.Deposit memory deposit =
            DepositMutation.Deposit({asset: address(1), amount: 100, nonce: 0, deadline: type(uint256).max});
        Signature memory sig = _signature(account, 1, pk2, DepositMutation.hashDeposit(deposit));

        vm.expectRevert(KeyExpired.selector);
        this.callVerifyDeposit(deposit, sig);
    }

    function test_SignatureExpired() external {
        _initAccount(pk1, pk2, account, PERM_DEPOSIT);
        DepositMutation.Deposit memory deposit =
            DepositMutation.Deposit({asset: address(1), amount: 100, nonce: 0, deadline: 0});
        Signature memory sig = _signature(account, 1, pk2, DepositMutation.hashDeposit(deposit));

        vm.warp(1);

        vm.expectRevert(SignatureExpired.selector);
        this.callVerifyDeposit(deposit, sig);
    }

    function test_InvalidNonce() external {
        _initAccount(pk1, pk2, account, PERM_DEPOSIT);
        DepositMutation.Deposit memory deposit =
            DepositMutation.Deposit({asset: address(1), amount: 100, nonce: 99, deadline: type(uint256).max});
        Signature memory sig = _signature(account, 1, pk2, DepositMutation.hashDeposit(deposit));

        vm.expectRevert(InvalidNonce.selector);
        this.callVerifyDeposit(deposit, sig);
    }

    function test_KeyNotFound() external {
        _initAccount(pk1, pk2, account, PERM_DEPOSIT);
        DepositMutation.Deposit memory deposit =
            DepositMutation.Deposit({asset: address(1), amount: 100, nonce: 0, deadline: type(uint256).max});
        Signature memory sig = _signature(account, 99, pk2, DepositMutation.hashDeposit(deposit));

        vm.expectRevert(KeyNotFound.selector);
        this.callVerifyDeposit(deposit, sig);
    }

    function test_PermissionEnforcement() external {
        _initAccount(pk1, pk2, account, PERM_DEPOSIT);

        WithdrawalMutation.Withdrawal memory withdrawal =
            WithdrawalMutation.Withdrawal({asset: address(1), amount: 100, nonce: 0, deadline: type(uint256).max});
        Signature memory sig = _signature(account, 1, pk2, WithdrawalMutation.hashWithdrawal(withdrawal));

        vm.expectRevert(Unauthorized.selector);
        this.callVerifyWithdrawal(withdrawal, sig);
    }

    function test_Initialize_P256RootKey() external {
        bytes32 p256Account = keccak256(_p256PublicKey(p256Pk1));
        InitializeMutation.Initialize memory init = InitializeMutation.Initialize({
            account: p256Account,
            expiry: 0,
            rootKeyType: uint8(KeyType.P256),
            keyType: uint8(KeyType.P256),
            permissions: 0x1ff,
            rootPublicKey: _p256PublicKey(p256Pk1),
            publicKey: _p256PublicKey(p256Pk2)
        });

        InitializeMutation.executeInitialize(state, init, Signature({account: p256Account, keyId: 0, rawSignature: ""}));

        assertEq(state.accounts[p256Account].keys.length, 2);
        assertEq(uint8(state.accounts[p256Account].keys[0].keyType), uint8(KeyType.P256));
        assertEq(state.accounts[p256Account].keys[0].permissions, type(uint16).max);
        assertEq(uint8(state.accounts[p256Account].keys[1].keyType), uint8(KeyType.P256));
        assertEq(state.accounts[p256Account].keys[1].permissions, 0x1ff);
    }

    function _digest(bytes32 structHash) private view returns (bytes32) {
        return keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR, structHash));
    }
}
