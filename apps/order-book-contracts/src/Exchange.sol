// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

struct State {
    address[] assets;
    Account[] accounts;
    Instrument[] instruments;
}

struct Account {
    uint256 nonce;
    mapping(uint64 => uint256) balances;
    Order[] orders;
}

struct Order {
    uint256 quantity;
    uint64 marketId;
    uint64 tickId;
    uint64 tickVolume;
    uint8 side; // 0: bid, 1: ask
}

struct Instrument {
    uint64 baseId;
    uint64 quoteId;
    mapping(uint64 => Tick) bids;
    mapping(uint64 => Tick) asks;
}

struct Tick {
    uint256 quantity;
    uint256 remainingQuantity;
    uint64 volume;
}

enum Mutation {
    MarketOrder,
    LimitOrder,
    CancelOrder,
    AddAccount,
    AddInstrument,
    AddAsset
}

struct MarketOrder {
    uint256 quantity;
    uint256 minReceivedQuantity;
    uint64 marketId;
    uint64 accountId;
    uint8 bidOrAsk; // 0: bid, 1: ask
}

struct Fill {
    uint256 quantity;
    uint64 tickId;
}

struct MarketOrderResolution {
    Fill[] fills;
}

struct LimitOrder {
    uint256 quantity;
    uint64 marketId;
    uint64 accountId;
    uint64 tickId;
    uint8 bidOrAsk; // 0: bid, 1: ask
}

struct LimitOrderResolution {
    Fill[] fills;
}

struct CancelOrder {
    uint64 accountId;
    uint64 orderId;
}

struct AddAccount {
    address addr;
}

struct AddInstrument {
    uint64 baseId;
    uint64 quoteId;
}

struct AddAsset {
    address asset;
}

struct ExecuteParams {
    Mutation[] mutations;
    bytes[] mutationData;
    uint8[] v;
    bytes32[] r;
    bytes32[] s;
}

error Unauthorized();
error LengthMismatch();
error InvalidMutation();
error InvalidInstrument();
error InvalidAccount();
error InvalidTick();
error InsufficientBalance();
error OrderNotFound();
error TickPartiallyFilled();
error SlippageExceeded();
error FillPriceExceedsLimit();

contract Exchange {
    address private immutable SCHEDULER;
    State state;

    constructor(address _scheduler) {
        SCHEDULER = _scheduler;
    }

    function _tickPrice(uint64 tickId) private pure returns (uint256) {
        return uint256(tickId);
    }

    function execute(ExecuteParams calldata params) external {
        if (msg.sender != SCHEDULER) {
            revert Unauthorized();
        }

        if (
            params.mutations.length != params.mutationData.length || params.mutations.length != params.v.length
                || params.mutations.length != params.r.length || params.mutations.length != params.s.length
        ) {
            revert LengthMismatch();
        }

        // TODO(kyle) bundle validation

        for (uint256 i = 0; i < params.mutations.length; i++) {
            Mutation mutation = params.mutations[i];
            bytes calldata data = params.mutationData[i];

            // TODO(kyle) signature validation

            if (mutation == Mutation.MarketOrder) {
                (MarketOrder memory order, MarketOrderResolution memory resolution) =
                    abi.decode(data, (MarketOrder, MarketOrderResolution));
                _executeMarketOrder(order, resolution);
            } else if (mutation == Mutation.LimitOrder) {
                (LimitOrder memory order, LimitOrderResolution memory resolution) =
                    abi.decode(data, (LimitOrder, LimitOrderResolution));
                _executeLimitOrder(order, resolution);
            } else if (mutation == Mutation.CancelOrder) {
                CancelOrder memory cancel = abi.decode(data, (CancelOrder));
                _executeCancelOrder(cancel);
            } else if (mutation == Mutation.AddAccount) {
                AddAccount memory account = abi.decode(data, (AddAccount));
                // TODO(kyle) execute
            } else if (mutation == Mutation.AddInstrument) {
                AddInstrument memory instrument = abi.decode(data, (AddInstrument));
                // TODO(kyle) execute
            } else if (mutation == Mutation.AddAsset) {
                AddAsset memory asset = abi.decode(data, (AddAsset));
                // TODO(kyle) execute
            } else {
                revert InvalidMutation();
            }
        }
    }

    function _settleFill(Fill memory fill, uint64 marketId, uint8 takerSide, uint64 takerAccountId) private {
        Instrument storage instrument = state.instruments[marketId];
        mapping(uint64 => Tick) storage ticks = takerSide == 0 ? instrument.asks : instrument.bids;

        Tick storage tick = ticks[fill.tickId];

        if (fill.quantity > tick.remainingQuantity) revert InvalidTick();

        tick.remainingQuantity -= fill.quantity;
        if (tick.remainingQuantity == 0) {
            tick.volume++;
            tick.quantity = 0;
            tick.remainingQuantity = 0;
        }

        // TODO(kyle) fix math
        uint256 quoteAmount = fill.quantity * _tickPrice(fill.tickId);
        Account storage taker = state.accounts[takerAccountId];

        if (takerSide == 0) {
            if (taker.balances[instrument.quoteId] < quoteAmount) revert InsufficientBalance();
            unchecked {
                taker.balances[instrument.quoteId] -= quoteAmount;
                taker.balances[instrument.baseId] += fill.quantity;
            }
        } else {
            if (taker.balances[instrument.baseId] < fill.quantity) revert InsufficientBalance();
            unchecked {
                taker.balances[instrument.baseId] -= fill.quantity;
                taker.balances[instrument.quoteId] += quoteAmount;
            }
        }
    }

    function _executeMarketOrder(MarketOrder memory order, MarketOrderResolution memory res) private {
        if (order.marketId >= state.instruments.length) revert InvalidInstrument();
        if (order.accountId >= state.accounts.length) revert InvalidAccount();

        Instrument storage instrument = state.instruments[order.marketId];

        uint256 totalFilled;
        uint256 totalReceived;
        for (uint256 i = 0; i < res.fills.length; i++) {
            Fill memory fill = res.fills[i];
            totalFilled += fill.quantity;
            _settleFill(fill, order.marketId, order.bidOrAsk, order.accountId);

            if (order.bidOrAsk == 0) {
                totalReceived += fill.quantity;
            } else {
                // TODO(kyle) fix math
                totalReceived += fill.quantity * _tickPrice(fill.tickId);
            }
        }

        if (totalFilled != order.quantity) revert InvalidMutation();
        if (totalReceived < order.minReceivedQuantity) revert SlippageExceeded();
    }

    function _executeLimitOrder(LimitOrder memory order, LimitOrderResolution memory res) private {
        if (order.marketId >= state.instruments.length) revert InvalidInstrument();
        if (order.accountId >= state.accounts.length) revert InvalidAccount();

        Instrument storage instrument = state.instruments[order.marketId];
        mapping(uint64 => Tick) storage ticks = order.bidOrAsk == 0 ? instrument.bids : instrument.asks;
        Tick storage tick = ticks[order.tickId];

        uint256 orderPrice = _tickPrice(order.tickId);
        uint256 totalFilled;
        for (uint256 i = 0; i < res.fills.length; i++) {
            uint256 fillPrice = _tickPrice(res.fills[i].tickId);
            if (order.bidOrAsk == 0) {
                if (fillPrice > orderPrice) revert FillPriceExceedsLimit();
            } else {
                if (fillPrice < orderPrice) revert FillPriceExceedsLimit();
            }
            totalFilled += res.fills[i].quantity;
            _settleFill(res.fills[i], order.marketId, order.bidOrAsk, order.accountId);
        }

        uint256 remaining = order.quantity - totalFilled;

        if (remaining > 0) {
            if (tick.remainingQuantity != tick.quantity) revert TickPartiallyFilled();

            Account storage account = state.accounts[order.accountId];
            if (order.bidOrAsk == 0) {
                // TODO(kyle) fix math
                uint256 lockAmount = remaining * _tickPrice(order.tickId);
                if (account.balances[instrument.quoteId] < lockAmount) revert InsufficientBalance();
                unchecked {
                    account.balances[instrument.quoteId] -= lockAmount;
                }
            } else {
                if (account.balances[instrument.baseId] < remaining) revert InsufficientBalance();
                unchecked {
                    account.balances[instrument.baseId] -= remaining;
                }
            }

            unchecked {
                tick.quantity += remaining;
                tick.remainingQuantity += remaining;
            }

            account.orders
                .push(
                    Order({
                        quantity: remaining,
                        marketId: order.marketId,
                        tickId: order.tickId,
                        tickVolume: tick.volume,
                        side: order.bidOrAsk
                    })
                );
        }
    }

    function _executeCancelOrder(CancelOrder memory cancel) private {
        if (cancel.accountId >= state.accounts.length) revert InvalidAccount();
        Account storage account = state.accounts[cancel.accountId];
        if (account.orders[cancel.orderId].quantity == 0) revert OrderNotFound();

        Order storage order = account.orders[cancel.orderId];
        Instrument storage instrument = state.instruments[order.marketId];
        mapping(uint64 => Tick) storage ticks = order.side == 0 ? instrument.bids : instrument.asks;
        Tick storage tick = ticks[order.tickId];

        uint256 unfilledQuantity;
        if (tick.volume > order.tickVolume) {
            unfilledQuantity = 0;
        } else {
            uint256 consumed = tick.quantity - tick.remainingQuantity;
            uint256 filledQuantity = (order.quantity * consumed) / tick.quantity;
            unfilledQuantity = order.quantity - filledQuantity;
        }

        if (unfilledQuantity > 0) {
            tick.quantity -= unfilledQuantity;
            tick.remainingQuantity -= unfilledQuantity;

            if (order.side == 0) {
                account.balances[instrument.quoteId] += unfilledQuantity * _tickPrice(order.tickId);
            } else {
                account.balances[instrument.baseId] += unfilledQuantity;
            }
        }

        delete account.orders[cancel.orderId];
    }


    function _executeAddAccount(AddAccount memory account) private {
        // TODO
    }

    function _executeAddInstrument(AddInstrument memory instrument) private {
        // TODO
    }

    function _executeAddAsset(AddAsset memory asset) private {
        // TODO
    }
}
