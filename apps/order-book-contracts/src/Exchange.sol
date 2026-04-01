// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

struct State {
    mapping(address => Account) accounts;
    mapping(uint64 => Instrument) instruments;
}

struct Account {
    uint256 nonce;
    mapping(address => uint256) balances;
    Order[] orders;
}

struct Order {
    uint64 quantity;
    uint64 instrumentId;
    uint64 price; // Q32.32
    uint32 tickVolume;
    uint8 side; // 0: bid, 1: ask
}

struct Instrument {
    address base;
    uint16 baseLotExp;
    address quote;
    uint16 quoteLotExp;
    mapping(uint64 => Tick) bids;
    mapping(uint64 => Tick) asks;
}

struct AddInstrumentParams {
    uint64 instrumentId;
    address base;
    address quote;
    uint16 baseLotExp;
    uint16 quoteLotExp;
}

struct Tick {
    uint64 quantity;
    uint64 remainingQuantity;
    uint32 volume;
}

enum Mutation {
    CloseOrder,
    LimitOrder,
    MarketOrder,
    AddInstrument,
    Deposit,
    Withdrawal
}

error MutationsOutOfOrder();

struct MarketOrder {
    uint64 quantity;
    uint64 minReceivedQuantity;
    uint64 instrumentId;
    uint8 bidOrAsk; // 0: bid, 1: ask
    uint256 nonce;
    uint256 deadline;
}

struct Fill {
    uint64 quantity;
    uint64 price; // Q32.32
}

struct MarketOrderResolution {
    Fill[] fills;
}

struct LimitOrder {
    uint64 quantity;
    uint64 instrumentId;
    uint64 price; // Q32.32
    uint8 bidOrAsk; // 0: bid, 1: ask
    uint256 nonce;
    uint256 deadline;
}

struct CloseOrder {
    uint64 orderId;
    uint256 nonce;
    uint256 deadline;
}

struct Deposit {
    address asset;
    uint256 amount;
    uint256 nonce;
    uint256 deadline;
}

struct Withdrawal {
    address asset;
    uint256 amount;
    uint256 nonce;
    uint256 deadline;
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
error InvalidTick();
error InsufficientBalance();
error OrderNotFound();
error TickPartiallyFilled();
error SlippageExceeded();
error SignatureExpired();
error InvalidNonce();
error InvalidSignature();
error InstrumentAlreadyExists();

contract Exchange {
    address private immutable SCHEDULER;
    State state;

    bytes32 private constant EIP712_DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");

    bytes32 private constant CLOSE_ORDER_TYPEHASH =
        keccak256("CloseOrder(uint64 orderId,uint256 nonce,uint256 deadline)");

    bytes32 private constant LIMIT_ORDER_TYPEHASH =
        keccak256("LimitOrder(uint64 quantity,uint64 instrumentId,uint64 price,uint8 bidOrAsk,uint256 nonce,uint256 deadline)");

    bytes32 private constant MARKET_ORDER_TYPEHASH =
        keccak256("MarketOrder(uint64 quantity,uint64 minReceivedQuantity,uint64 instrumentId,uint8 bidOrAsk,uint256 nonce,uint256 deadline)");

    bytes32 private constant DEPOSIT_TYPEHASH =
        keccak256("Deposit(address asset,uint256 amount,uint256 nonce,uint256 deadline)");

    bytes32 private constant WITHDRAWAL_TYPEHASH =
        keccak256("Withdrawal(address asset,uint256 amount,uint256 nonce,uint256 deadline)");

    uint256 private immutable INITIAL_CHAIN_ID;
    bytes32 private immutable INITIAL_DOMAIN_SEPARATOR;

    constructor(address _scheduler) {
        SCHEDULER = _scheduler;
        INITIAL_CHAIN_ID = block.chainid;
        INITIAL_DOMAIN_SEPARATOR = _computeDomainSeparator();
    }

    function DOMAIN_SEPARATOR() public view returns (bytes32) {
        return block.chainid == INITIAL_CHAIN_ID ? INITIAL_DOMAIN_SEPARATOR : _computeDomainSeparator();
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

        Mutation prev = Mutation.CloseOrder;
        for (uint256 i = 0; i < params.mutations.length; i++) {
            Mutation mutation = params.mutations[i];
            if (mutation < prev) revert MutationsOutOfOrder();
            prev = mutation;

            bytes calldata data = params.mutationData[i];

            if (mutation == Mutation.CloseOrder) {
                CloseOrder memory close = abi.decode(data, (CloseOrder));
                address account = _verifySig(
                    keccak256(abi.encode(CLOSE_ORDER_TYPEHASH, close.orderId, close.nonce, close.deadline)),
                    close.nonce, close.deadline, params.v[i], params.r[i], params.s[i]
                );
                _executeCloseOrder(close, account);
            } else if (mutation == Mutation.LimitOrder) {
                LimitOrder memory order = abi.decode(data, (LimitOrder));
                address account = _verifySig(
                    keccak256(abi.encode(LIMIT_ORDER_TYPEHASH, order.quantity, order.instrumentId, order.price, order.bidOrAsk, order.nonce, order.deadline)),
                    order.nonce, order.deadline, params.v[i], params.r[i], params.s[i]
                );
                _executeLimitOrder(order, account);
            } else if (mutation == Mutation.MarketOrder) {
                (MarketOrder memory order, MarketOrderResolution memory resolution) =
                    abi.decode(data, (MarketOrder, MarketOrderResolution));
                address account = _verifySig(
                    keccak256(abi.encode(MARKET_ORDER_TYPEHASH, order.quantity, order.minReceivedQuantity, order.instrumentId, order.bidOrAsk, order.nonce, order.deadline)),
                    order.nonce, order.deadline, params.v[i], params.r[i], params.s[i]
                );
                _executeMarketOrder(order, resolution, account);
            } else if (mutation == Mutation.AddInstrument) {
                AddInstrumentParams memory p = abi.decode(data, (AddInstrumentParams));
                Instrument storage inst = state.instruments[p.instrumentId];
                if (inst.base != address(0)) revert InstrumentAlreadyExists();
                inst.base = p.base;
                inst.quote = p.quote;
                inst.baseLotExp = p.baseLotExp;
                inst.quoteLotExp = p.quoteLotExp;
            } else if (mutation == Mutation.Deposit) {
                Deposit memory d = abi.decode(data, (Deposit));
                address account = _verifySig(
                    keccak256(abi.encode(DEPOSIT_TYPEHASH, d.asset, d.amount, d.nonce, d.deadline)),
                    d.nonce, d.deadline, params.v[i], params.r[i], params.s[i]
                );
                state.accounts[account].balances[d.asset] += d.amount;
            } else if (mutation == Mutation.Withdrawal) {
                Withdrawal memory w = abi.decode(data, (Withdrawal));
                address account = _verifySig(
                    keccak256(abi.encode(WITHDRAWAL_TYPEHASH, w.asset, w.amount, w.nonce, w.deadline)),
                    w.nonce, w.deadline, params.v[i], params.r[i], params.s[i]
                );
                if (state.accounts[account].balances[w.asset] < w.amount) revert InsufficientBalance();
                unchecked {
                    state.accounts[account].balances[w.asset] -= w.amount;
                }
            } else {
                revert InvalidMutation();
            }
        }
    }

    function _verifySig(bytes32 structHash, uint256 nonce, uint256 deadline, uint8 v, bytes32 r, bytes32 s) internal returns (address) {
        if (deadline < block.timestamp) revert SignatureExpired();

        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR(), structHash));
        address account = ecrecover(digest, v, r, s);
        if (account == address(0)) revert InvalidSignature();

        if (nonce != state.accounts[account].nonce) revert InvalidNonce();
        state.accounts[account].nonce++;

        return account;
    }

    function _settleFill(Fill memory fill, Instrument storage instrument, uint8 takerSide, address takerAccount) internal {
        mapping(uint64 => Tick) storage ticks = takerSide == 0 ? instrument.asks : instrument.bids;

        Tick storage tick = ticks[fill.price];

        if (fill.quantity > tick.remainingQuantity) revert InvalidTick();

        tick.remainingQuantity -= fill.quantity;
        if (tick.remainingQuantity == 0) {
            tick.volume++;
            tick.quantity = 0;
            tick.remainingQuantity = 0;
        }

        uint256 rawBase = uint256(fill.quantity) << instrument.baseLotExp;
        uint256 rawQuote = ((uint256(fill.quantity) * uint256(fill.price)) >> 32) << instrument.quoteLotExp;
        Account storage taker = state.accounts[takerAccount];

        if (takerSide == 0) {
            if (taker.balances[instrument.quote] < rawQuote) revert InsufficientBalance();
            unchecked {
                taker.balances[instrument.quote] -= rawQuote;
                taker.balances[instrument.base] += rawBase;
            }
        } else {
            if (taker.balances[instrument.base] < rawBase) revert InsufficientBalance();
            unchecked {
                taker.balances[instrument.base] -= rawBase;
                taker.balances[instrument.quote] += rawQuote;
            }
        }
    }

    function _executeMarketOrder(MarketOrder memory order, MarketOrderResolution memory res, address account) internal {
        Instrument storage instrument = state.instruments[order.instrumentId];
        if (instrument.base == address(0)) revert InvalidInstrument();

        uint256 totalFilled;
        uint256 totalReceived;
        for (uint256 i = 0; i < res.fills.length; i++) {
            Fill memory fill = res.fills[i];
            totalFilled += fill.quantity;
            _settleFill(fill, instrument, order.bidOrAsk, account);

            if (order.bidOrAsk == 0) {
                totalReceived += fill.quantity;
            } else {
                totalReceived += (fill.quantity * uint256(fill.price)) >> 32;
            }
        }

        if (totalFilled != order.quantity) revert InvalidMutation();
        if (totalReceived < order.minReceivedQuantity) revert SlippageExceeded();
    }

    function _executeLimitOrder(LimitOrder memory order, address account) internal {
        Instrument storage instrument = state.instruments[order.instrumentId];
        if (instrument.base == address(0)) revert InvalidInstrument();
        mapping(uint64 => Tick) storage ticks = order.bidOrAsk == 0 ? instrument.bids : instrument.asks;
        Tick storage tick = ticks[order.price];

        if (tick.remainingQuantity != tick.quantity) revert TickPartiallyFilled();

        Account storage acc = state.accounts[account];
        if (order.bidOrAsk == 0) {
            uint256 rawLock = ((uint256(order.quantity) * uint256(order.price)) >> 32) << instrument.quoteLotExp;
            if (acc.balances[instrument.quote] < rawLock) revert InsufficientBalance();
            unchecked {
                acc.balances[instrument.quote] -= rawLock;
            }
        } else {
            uint256 rawBase = uint256(order.quantity) << instrument.baseLotExp;
            if (acc.balances[instrument.base] < rawBase) revert InsufficientBalance();
            unchecked {
                acc.balances[instrument.base] -= rawBase;
            }
        }

        unchecked {
            tick.quantity += order.quantity;
            tick.remainingQuantity += order.quantity;
        }

        acc.orders.push(
            Order({
                quantity: order.quantity,
                instrumentId: order.instrumentId,
                price: order.price,
                tickVolume: tick.volume,
                side: order.bidOrAsk
            })
        );
    }

    function _executeCloseOrder(CloseOrder memory close, address account) internal {
        Account storage acc = state.accounts[account];
        if (acc.orders[close.orderId].quantity == 0) revert OrderNotFound();

        Order storage order = acc.orders[close.orderId];
        Instrument storage instrument = state.instruments[order.instrumentId];
        mapping(uint64 => Tick) storage ticks = order.side == 0 ? instrument.bids : instrument.asks;
        Tick storage tick = ticks[order.price];

        uint64 filledQuantity;
        uint64 unfilledQuantity;
        if (tick.volume > order.tickVolume) {
            filledQuantity = order.quantity;
        } else {
            uint256 consumed = tick.quantity - tick.remainingQuantity;
            filledQuantity = uint64((uint256(order.quantity) * consumed) / tick.quantity);
            unfilledQuantity = order.quantity - filledQuantity;
        }

        if (unfilledQuantity > 0) {
            tick.quantity -= unfilledQuantity;
            tick.remainingQuantity -= unfilledQuantity;
        }

        if (order.side == 0) {
            acc.balances[instrument.quote] += ((uint256(unfilledQuantity) * uint256(order.price)) >> 32) << instrument.quoteLotExp;
            acc.balances[instrument.base] += uint256(filledQuantity) << instrument.baseLotExp;
        } else {
            acc.balances[instrument.base] += uint256(unfilledQuantity) << instrument.baseLotExp;
            acc.balances[instrument.quote] += ((uint256(filledQuantity) * uint256(order.price)) >> 32) << instrument.quoteLotExp;
        }

        delete acc.orders[close.orderId];
    }

    function _computeDomainSeparator() private view returns (bytes32) {
        return keccak256(
            abi.encode(EIP712_DOMAIN_TYPEHASH, keccak256("Exchange"), keccak256("1"), block.chainid, address(this))
        );
    }
}
