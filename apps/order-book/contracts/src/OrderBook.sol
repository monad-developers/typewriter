// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Typewriter, UnknownMutation} from "typewriter/Typewriter.sol";

struct State {
    mapping(bytes32 => Account) accounts;
    mapping(uint64 => Instrument) instruments;
}

struct Account {
    mapping(address => uint256) balances;
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
    uint64 bestBid;
    uint64 bestAsk;
    mapping(uint64 => Tick) bids;
    mapping(uint64 => Tick) asks;
}

struct Tick {
    uint64 quantity;
    uint64 remainingQuantity;
    uint32 volume;
    uint64 prev;
    uint64 next;
}

error InvalidMutation();
error InvalidInstrument();
error InvalidTick();
error InsufficientBalance();
error OrderNotFound();
error TickPartiallyFilled();
error SlippageExceeded();
error InstrumentAlreadyExists();
error AmountNotLotMultiple();
error LotExpTooLarge();

function toLots(uint256 fullAmount, uint8 lotExp) pure returns (uint64) {
    uint256 lots = fullAmount >> lotExp;
    if (lots << lotExp != fullAmount) revert AmountNotLotMultiple();
    if (lots > type(uint64).max) revert AmountNotLotMultiple();
    return uint64(lots);
}

function getTicks(Instrument storage instrument, uint8 side) view returns (mapping(uint64 => Tick) storage ticks) {
    if (side == 0) return instrument.bids;
    if (side == 1) return instrument.asks;
    revert InvalidMutation();
}

function bestTick(Instrument storage instrument, uint8 side) view returns (uint64) {
    if (side == 0) return instrument.bestBid;
    if (side == 1) return instrument.bestAsk;
    revert InvalidMutation();
}

function setBestTick(Instrument storage instrument, uint8 side, uint64 price) {
    if (side == 0) {
        instrument.bestBid = price;
        return;
    }
    if (side == 1) {
        instrument.bestAsk = price;
        return;
    }
    revert InvalidMutation();
}

function isBetterPrice(uint8 side, uint64 price, uint64 other) pure returns (bool) {
    return side == 0 ? price > other : price < other;
}

function insertBookTick(Instrument storage instrument, uint8 side, uint64 price) {
    if (price == 0) revert InvalidTick();

    mapping(uint64 => Tick) storage ticks = getTicks(instrument, side);
    uint64 best = bestTick(instrument, side);
    Tick storage tick = ticks[price];

    if (best == 0) {
        setBestTick(instrument, side, price);
        return;
    }

    if (isBetterPrice(side, price, best)) {
        tick.next = best;
        ticks[best].prev = price;
        setBestTick(instrument, side, price);
        return;
    }

    uint64 current = best;
    while (true) {
        uint64 next = ticks[current].next;
        if (next == 0 || isBetterPrice(side, price, next)) {
            tick.prev = current;
            tick.next = next;
            ticks[current].next = price;
            if (next != 0) ticks[next].prev = price;
            return;
        }
        current = next;
    }
}

function removeBookTick(Instrument storage instrument, uint8 side, uint64 price) {
    mapping(uint64 => Tick) storage ticks = getTicks(instrument, side);
    Tick storage tick = ticks[price];
    uint64 prev = tick.prev;
    uint64 next = tick.next;

    if (prev == 0) {
        setBestTick(instrument, side, next);
    } else {
        ticks[prev].next = next;
    }
    if (next != 0) ticks[next].prev = prev;

    tick.prev = 0;
    tick.next = 0;
}

import {AddInstrumentMutation} from "./AddInstrument.sol";
import {ChangeOrderMutation} from "./ChangeOrder.sol";
import {CloseOrderMutation} from "./CloseOrder.sol";
import {DepositMutation} from "./Deposit.sol";
import {LimitOrderMutation} from "./LimitOrder.sol";
import {MarketOrderMutation} from "./MarketOrder.sol";
import {WithdrawalMutation} from "./Withdrawal.sol";

contract OrderBook is Typewriter {
    enum Mutation {
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
        FORCE_INCLUSION_DELAY = 658;
    }

    function dispatch(uint8 mutation, bytes memory mutationData, bytes32 accountID) internal override {
        if (mutation == uint8(Mutation.CloseOrder)) {
            CloseOrderMutation.CloseOrder memory closeOrder = abi.decode(mutationData, (CloseOrderMutation.CloseOrder));
            CloseOrderMutation.executeCloseOrder(state, closeOrder, accountID);
        } else if (mutation == uint8(Mutation.ChangeOrder)) {
            ChangeOrderMutation.ChangeOrder memory changeOrder =
                abi.decode(mutationData, (ChangeOrderMutation.ChangeOrder));
            ChangeOrderMutation.executeChangeOrder(state, changeOrder, accountID);
        } else if (mutation == uint8(Mutation.LimitOrder)) {
            LimitOrderMutation.LimitOrder memory order = abi.decode(mutationData, (LimitOrderMutation.LimitOrder));
            LimitOrderMutation.executeLimitOrder(state, order, accountID);
        } else if (mutation == uint8(Mutation.MarketOrder)) {
            MarketOrderMutation.MarketOrder memory order = abi.decode(mutationData, (MarketOrderMutation.MarketOrder));
            MarketOrderMutation.executeMarketOrder(state, order, accountID);
        } else if (mutation == uint8(Mutation.AddInstrument)) {
            AddInstrumentMutation.AddInstrument memory instrument =
                abi.decode(mutationData, (AddInstrumentMutation.AddInstrument));
            AddInstrumentMutation.executeAddInstrument(state, instrument);
        } else if (mutation == uint8(Mutation.Deposit)) {
            DepositMutation.Deposit memory deposit = abi.decode(mutationData, (DepositMutation.Deposit));
            DepositMutation.executeDeposit(state, deposit, accountID);
        } else if (mutation == uint8(Mutation.Withdrawal)) {
            WithdrawalMutation.Withdrawal memory withdrawal = abi.decode(mutationData, (WithdrawalMutation.Withdrawal));
            WithdrawalMutation.executeWithdrawal(state, withdrawal, accountID);
        } else {
            revert UnknownMutation(mutation);
        }
    }
}
