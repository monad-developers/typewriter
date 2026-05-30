// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {EIP712_DOMAIN_TYPEHASH, FFCA, KeyType, UnknownMutation, verifySignature} from "ffca/FFCA.sol";

struct Key {
    uint40 expiry;
    KeyType keyType;
    uint16 permissions;
    bytes publicKey;
}

struct State {
    mapping(bytes32 => Account) accounts;
    mapping(uint64 => Instrument) instruments;
}

struct Account {
    mapping(uint192 => uint64) nonces;
    mapping(address => uint256) balances;
    Key[] keys;
    Order[] orders;
}

struct Order {
    uint64 quantity;
    uint64 instrumentId;
    uint64 price;
    uint32 tickVolume;
    uint8 side;
}

struct Instrument {
    address base;
    address quote;
    uint8 baseLotExp;
    uint8 quoteLotExp;
    mapping(uint64 => Tick) bids;
    mapping(uint64 => Tick) asks;
}

struct Tick {
    uint64 quantity;
    uint64 remainingQuantity;
    uint32 volume;
}

struct Signature {
    bytes32 account;
    uint64 keyId;
    bytes rawSignature;
}

uint16 constant PERM_AUTHORIZE = 1 << 0;
uint16 constant PERM_REVOKE = 1 << 1;
uint16 constant PERM_CLOSE_ORDER = 1 << 2;
uint16 constant PERM_LIMIT_ORDER = 1 << 3;
uint16 constant PERM_MARKET_ORDER = 1 << 4;
uint16 constant PERM_DEPOSIT = 1 << 5;
uint16 constant PERM_WITHDRAW = 1 << 6;
uint16 constant PERM_ADD_INSTRUMENT = 1 << 7;
uint16 constant PERM_CHANGE_ORDER = 1 << 8;

error Unauthorized();
error InvalidMutation();
error InvalidInstrument();
error InvalidTick();
error InsufficientBalance();
error OrderNotFound();
error TickPartiallyFilled();
error SlippageExceeded();
error SignatureExpired();
error InvalidNonce();
error InstrumentAlreadyExists();
error AlreadyInitialized();
error InvalidAccount();
error AmountNotLotMultiple();
error LotExpTooLarge();
error KeyNotFound();
error KeyExpired();

function verifyMutationSignature(
    State storage state,
    Signature memory signature,
    bytes32 digest,
    uint256 nonce,
    uint256 deadline
) returns (uint16 permissions) {
    if (deadline < block.timestamp) revert SignatureExpired();

    Account storage account = state.accounts[signature.account];
    if (signature.keyId >= account.keys.length) revert KeyNotFound();
    Key storage key = account.keys[signature.keyId];
    if (key.permissions == 0) revert KeyNotFound();
    if (key.expiry != 0 && key.expiry < block.timestamp) revert KeyExpired();

    verifySignature(key.keyType, digest, key.publicKey, signature.rawSignature);

    uint192 nonceKey = uint192(nonce >> 64);
    uint64 nonceSeq = uint64(nonce);
    uint64 stored = account.nonces[nonceKey];
    if (nonceSeq != stored) revert InvalidNonce();
    unchecked {
        account.nonces[nonceKey] = stored + 1;
    }

    return key.permissions;
}

function toLots(uint256 fullAmount, uint8 lotExp) pure returns (uint64) {
    uint256 lots = fullAmount >> lotExp;
    if (lots << lotExp != fullAmount) revert AmountNotLotMultiple();
    if (lots > type(uint64).max) revert AmountNotLotMultiple();
    return uint64(lots);
}

import {AddInstrumentMutation} from "./AddInstrument.sol";
import {AuthorizeMutation} from "./Authorize.sol";
import {ChangeOrderMutation} from "./ChangeOrder.sol";
import {CloseOrderMutation} from "./CloseOrder.sol";
import {DepositMutation} from "./Deposit.sol";
import {InitializeMutation} from "./Initialize.sol";
import {LimitOrderMutation} from "./LimitOrder.sol";
import {MarketOrderMutation} from "./MarketOrder.sol";
import {RevokeMutation} from "./Revoke.sol";
import {WithdrawalMutation} from "./Withdrawal.sol";

contract Exchange is FFCA {
    enum Mutation {
        Initialize,
        Authorize,
        Revoke,
        CloseOrder,
        ChangeOrder,
        LimitOrder,
        MarketOrder,
        AddInstrument,
        Deposit,
        Withdrawal
    }

    State internal state;

    constructor(address _scheduler) {
        SCHEDULER = _scheduler;
        DOMAIN_SEPARATOR = keccak256(
            abi.encode(
                EIP712_DOMAIN_TYPEHASH,
                keccak256(bytes("Exchange")),
                keccak256(bytes("1")),
                block.chainid,
                address(this)
            )
        );
        FORCE_INCLUSION_DELAY = 658;
    }

    function dispatch(uint8 mutation, bytes memory mutationData, bytes memory signatureData) internal override {
        if (Mutation(mutation) == Mutation.Initialize) {
            InitializeMutation.Initialize memory initialize = abi.decode(mutationData, (InitializeMutation.Initialize));
            Signature memory signature = abi.decode(signatureData, (Signature));

            InitializeMutation.executeInitialize(state, initialize, signature);
        } else if (Mutation(mutation) == Mutation.Authorize) {
            AuthorizeMutation.Authorize memory authorize = abi.decode(mutationData, (AuthorizeMutation.Authorize));
            Signature memory signature = abi.decode(signatureData, (Signature));
            bytes32 digest =
                keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR, AuthorizeMutation.hashAuthorize(authorize)));

            AuthorizeMutation.verifyAuthorizeSignature(state, authorize, signature, digest);
            AuthorizeMutation.executeAuthorize(state, authorize, signature);
        } else if (Mutation(mutation) == Mutation.Revoke) {
            RevokeMutation.Revoke memory revoke = abi.decode(mutationData, (RevokeMutation.Revoke));
            Signature memory signature = abi.decode(signatureData, (Signature));
            bytes32 digest =
                keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR, RevokeMutation.hashRevoke(revoke)));

            RevokeMutation.verifyRevokeSignature(state, revoke, signature, digest);
            RevokeMutation.executeRevoke(state, revoke, signature);
        } else if (Mutation(mutation) == Mutation.CloseOrder) {
            CloseOrderMutation.CloseOrder memory closeOrder = abi.decode(mutationData, (CloseOrderMutation.CloseOrder));
            Signature memory signature = abi.decode(signatureData, (Signature));
            bytes32 digest = keccak256(
                abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR, CloseOrderMutation.hashCloseOrder(closeOrder))
            );

            CloseOrderMutation.verifyCloseOrderSignature(state, closeOrder, signature, digest);
            CloseOrderMutation.executeCloseOrder(state, closeOrder, signature);
        } else if (Mutation(mutation) == Mutation.ChangeOrder) {
            ChangeOrderMutation.ChangeOrder memory changeOrder =
                abi.decode(mutationData, (ChangeOrderMutation.ChangeOrder));
            Signature memory signature = abi.decode(signatureData, (Signature));
            bytes32 digest = keccak256(
                abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR, ChangeOrderMutation.hashChangeOrder(changeOrder))
            );

            ChangeOrderMutation.verifyChangeOrderSignature(state, changeOrder, signature, digest);
            ChangeOrderMutation.executeChangeOrder(state, changeOrder, signature);
        } else if (Mutation(mutation) == Mutation.LimitOrder) {
            LimitOrderMutation.LimitOrder memory order = abi.decode(mutationData, (LimitOrderMutation.LimitOrder));
            Signature memory signature = abi.decode(signatureData, (Signature));
            bytes32 digest =
                keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR, LimitOrderMutation.hashLimitOrder(order)));

            LimitOrderMutation.verifyLimitOrderSignature(state, order, signature, digest);
            LimitOrderMutation.executeLimitOrder(state, order, signature);
        } else if (Mutation(mutation) == Mutation.MarketOrder) {
            (
                MarketOrderMutation.MarketOrder memory order,
                MarketOrderMutation.MarketOrderResolution memory resolution
            ) = abi.decode(mutationData, (MarketOrderMutation.MarketOrder, MarketOrderMutation.MarketOrderResolution));
            Signature memory signature = abi.decode(signatureData, (Signature));
            bytes32 digest =
                keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR, MarketOrderMutation.hashMarketOrder(order)));

            MarketOrderMutation.verifyMarketOrderSignature(state, order, signature, digest);
            MarketOrderMutation.executeMarketOrder(state, order, resolution, signature);
        } else if (Mutation(mutation) == Mutation.AddInstrument) {
            AddInstrumentMutation.AddInstrument memory instrument =
                abi.decode(mutationData, (AddInstrumentMutation.AddInstrument));
            Signature memory signature = abi.decode(signatureData, (Signature));
            bytes32 digest = keccak256(
                abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR, AddInstrumentMutation.hashAddInstrument(instrument))
            );

            AddInstrumentMutation.verifyAddInstrumentSignature(state, instrument, signature, digest);
            AddInstrumentMutation.executeAddInstrument(state, instrument);
        } else if (Mutation(mutation) == Mutation.Deposit) {
            DepositMutation.Deposit memory deposit = abi.decode(mutationData, (DepositMutation.Deposit));
            Signature memory signature = abi.decode(signatureData, (Signature));
            bytes32 digest =
                keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR, DepositMutation.hashDeposit(deposit)));

            DepositMutation.verifyDepositSignature(state, deposit, signature, digest);
            DepositMutation.executeDeposit(state, deposit, signature);
        } else if (Mutation(mutation) == Mutation.Withdrawal) {
            WithdrawalMutation.Withdrawal memory withdrawal = abi.decode(mutationData, (WithdrawalMutation.Withdrawal));
            Signature memory signature = abi.decode(signatureData, (Signature));
            bytes32 digest = keccak256(
                abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR, WithdrawalMutation.hashWithdrawal(withdrawal))
            );

            WithdrawalMutation.verifyWithdrawalSignature(state, withdrawal, signature, digest);
            WithdrawalMutation.executeWithdrawal(state, withdrawal, signature);
        } else {
            revert UnknownMutation(mutation);
        }
    }
}
