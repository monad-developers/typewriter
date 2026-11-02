// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Typewriter, UnknownMutation} from "typewriter/Typewriter.sol";

enum Side {
    Buy,
    Sell
}

enum MarketStatus {
    Active,
    ReduceOnly,
    Halted
}

/// Prices are collateral units per lot, sizes are lots, and collateral is
/// signed so realized losses and funding can leave an account in debt.
struct State {
    bytes32 admin;
    int256 insuranceFund;
    uint64 lastOrderId;
    uint64[] marketIds;
    mapping(uint64 => Market) markets;
    mapping(bytes32 => Account) accounts;
    mapping(uint64 => Order) orders;
}

struct Market {
    bool listed;
    MarketStatus status;
    uint16 initialMarginBps;
    uint16 maintenanceMarginBps;
    uint16 takerFeeBps;
    uint16 liquidationFeeBps;
    uint64 tickSize;
    uint64 oraclePrice;
    uint64 openInterest;
    uint64 bestBid;
    uint64 bestAsk;
    int256 cumulativeFunding;
    mapping(uint64 => Level) bids;
    mapping(uint64 => Level) asks;
}

/// A price level: a FIFO list of orders, linked to the next worse level.
struct Level {
    uint64 quantity;
    uint64 head;
    uint64 tail;
    uint64 prev;
    uint64 next;
}

struct Order {
    bytes32 account;
    uint64 marketId;
    uint64 price;
    uint64 quantity;
    uint64 prev;
    uint64 next;
    uint32 index;
    Side side;
}

struct Account {
    int256 collateral;
    uint64[] marketIds;
    mapping(uint64 => Position) positions;
}

struct Position {
    int64 size;
    uint32 index;
    uint64 bidLots;
    uint64 askLots;
    int256 cost;
    int256 fundingIndex;
    uint64[] orderIds;
}

uint256 constant BPS = 10_000;
uint16 constant MAX_FEE_BPS = 1_000;

error NotAdmin();
error InvalidAdmin();
error MarketExists();
error MarketNotFound();
error MarketHalted();
error ReduceOnly();
error InvalidRiskParams();
error InvalidPrice();
error InvalidOrder();
error WouldCross();
error OrderNotFound();
error NotOrderOwner();
error InsufficientLiquidity();
error InsufficientMargin();
error InsufficientCollateral();
error NotLiquidatable();
error NoPosition();
error SizeOverflow();

function requireAdmin(State storage state, bytes32 accountID) view {
    if (state.admin == bytes32(0) || state.admin != accountID) revert NotAdmin();
}

function listedMarket(State storage state, uint64 marketId) view returns (Market storage market) {
    market = state.markets[marketId];
    if (!market.listed) revert MarketNotFound();
}

function validateRiskParams(
    uint16 initialMarginBps,
    uint16 maintenanceMarginBps,
    uint16 takerFeeBps,
    uint16 liquidationFeeBps
) pure {
    if (
        maintenanceMarginBps == 0 || maintenanceMarginBps >= initialMarginBps || initialMarginBps > BPS
            || takerFeeBps > MAX_FEE_BPS || liquidationFeeBps > MAX_FEE_BPS
    ) revert InvalidRiskParams();
}

import {AccrueFundingMutation} from "./AccrueFunding.sol";
import {AddMarketMutation} from "./AddMarket.sol";
import {CancelOrderMutation} from "./CancelOrder.sol";
import {DepositMutation} from "./Deposit.sol";
import {LimitOrderMutation} from "./LimitOrder.sol";
import {LiquidateMutation} from "./Liquidate.sol";
import {MarketOrderMutation} from "./MarketOrder.sol";
import {SetAdminMutation} from "./SetAdmin.sol";
import {SetOraclePricesMutation} from "./SetOraclePrices.sol";
import {UpdateMarketMutation} from "./UpdateMarket.sol";
import {WithdrawalMutation} from "./Withdrawal.sol";

contract Perps is Typewriter {
    enum Mutation {
        SetAdmin,
        AddMarket,
        UpdateMarket,
        SetOraclePrices,
        AccrueFunding,
        Deposit,
        Liquidate,
        CancelOrder,
        LimitOrder,
        MarketOrder,
        Withdrawal
    }

    State internal state;

    constructor(address _scheduler) Typewriter(_scheduler) {}

    function dispatch(uint8 mutation, bytes memory mutationData, bytes32 accountID) internal override {
        if (mutation == uint8(Mutation.SetAdmin)) {
            SetAdminMutation.execute(state, abi.decode(mutationData, (SetAdminMutation.SetAdmin)), accountID);
        } else if (mutation == uint8(Mutation.AddMarket)) {
            AddMarketMutation.execute(state, abi.decode(mutationData, (AddMarketMutation.AddMarket)), accountID);
        } else if (mutation == uint8(Mutation.UpdateMarket)) {
            UpdateMarketMutation.execute(
                state, abi.decode(mutationData, (UpdateMarketMutation.UpdateMarket)), accountID
            );
        } else if (mutation == uint8(Mutation.SetOraclePrices)) {
            SetOraclePricesMutation.execute(
                state, abi.decode(mutationData, (SetOraclePricesMutation.SetOraclePrices)), accountID
            );
        } else if (mutation == uint8(Mutation.AccrueFunding)) {
            AccrueFundingMutation.execute(
                state, abi.decode(mutationData, (AccrueFundingMutation.AccrueFunding)), accountID
            );
        } else if (mutation == uint8(Mutation.Deposit)) {
            DepositMutation.execute(state, abi.decode(mutationData, (DepositMutation.Deposit)), accountID);
        } else if (mutation == uint8(Mutation.Liquidate)) {
            LiquidateMutation.execute(state, abi.decode(mutationData, (LiquidateMutation.Liquidate)), accountID);
        } else if (mutation == uint8(Mutation.CancelOrder)) {
            CancelOrderMutation.execute(state, abi.decode(mutationData, (CancelOrderMutation.CancelOrder)), accountID);
        } else if (mutation == uint8(Mutation.LimitOrder)) {
            LimitOrderMutation.execute(state, abi.decode(mutationData, (LimitOrderMutation.LimitOrder)), accountID);
        } else if (mutation == uint8(Mutation.MarketOrder)) {
            MarketOrderMutation.execute(state, abi.decode(mutationData, (MarketOrderMutation.MarketOrder)), accountID);
        } else if (mutation == uint8(Mutation.Withdrawal)) {
            WithdrawalMutation.execute(state, abi.decode(mutationData, (WithdrawalMutation.Withdrawal)), accountID);
        } else {
            revert UnknownMutation(mutation);
        }
    }
}
