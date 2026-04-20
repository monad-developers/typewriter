// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

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
    REVOKE_TYPEHASH,
    verify,
    verifySignature
} from "./Account.sol";

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
    uint64 quantity; // lots
    uint64 instrumentId;
    uint64 price; // Q32.32
    uint32 tickVolume;
    uint8 side; // 0: bid, 1: ask
}

struct Instrument {
    address base;
    uint8 baseLotExp;
    address quote;
    uint8 quoteLotExp;
    mapping(uint64 => Tick) bids;
    mapping(uint64 => Tick) asks;
}

struct Tick {
    uint64 quantity; // lots
    uint64 remainingQuantity; // lots
    uint32 volume;
}

enum Mutation {
    Initialize,
    Authorize,
    Revoke,
    CloseOrder,
    LimitOrder,
    MarketOrder,
    AddInstrument,
    Deposit,
    Withdrawal
}

struct CloseOrder {
    uint64 orderId;
    uint256 nonce;
    uint256 deadline;
}

struct LimitOrder {
    uint256 quantity;
    uint64 instrumentId;
    uint64 price; // Q32.32
    uint8 bidOrAsk; // 0: bid, 1: ask
    uint256 nonce;
    uint256 deadline;
}

struct MarketOrder {
    uint256 quantity;
    uint256 minReceivedQuantity;
    uint64 instrumentId;
    uint8 bidOrAsk; // 0: bid, 1: ask
    uint256 nonce;
    uint256 deadline;
}

struct MarketOrderResolution {
    Fill[] fills;
}

struct Fill {
    uint64 quantity; // lots
    uint64 price; // Q32.32
}

struct AddInstrument {
    uint64 instrumentId;
    address base;
    address quote;
    uint8 baseLotExp;
    uint8 quoteLotExp;
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

struct Bundle {
    Mutation[] mutations;
    bytes[] mutationData;
    Signature[] signatures;
}

struct Signature {
    bytes32 account;
    uint64 keyId;
    bytes rawSignature;
}

uint8 constant PERM_AUTHORIZE = 1 << 0;
uint8 constant PERM_REVOKE = 1 << 1;
uint8 constant PERM_CLOSE_ORDER = 1 << 2;
uint8 constant PERM_LIMIT_ORDER = 1 << 3;
uint8 constant PERM_MARKET_ORDER = 1 << 4;
uint8 constant PERM_DEPOSIT = 1 << 5;
uint8 constant PERM_WITHDRAW = 1 << 6;
uint8 constant PERM_ADD_INSTRUMENT = 1 << 7;

error MutationsOutOfOrder();
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
error InstrumentAlreadyExists();
error AlreadyInitialized();
error MissingAuthorizePermission();
error AmountNotLotMultiple();
error LotExpTooLarge();

contract Exchange {
    address internal immutable SCHEDULER;
    State internal state;

    bytes32 private constant EIP712_DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");

    bytes32 private constant CLOSE_ORDER_TYPEHASH =
        keccak256("CloseOrder(uint64 orderId,uint256 nonce,uint256 deadline)");

    bytes32 private constant LIMIT_ORDER_TYPEHASH = keccak256(
        "LimitOrder(uint256 quantity,uint64 instrumentId,uint64 price,uint8 bidOrAsk,uint256 nonce,uint256 deadline)"
    );

    bytes32 private constant MARKET_ORDER_TYPEHASH = keccak256(
        "MarketOrder(uint256 quantity,uint256 minReceivedQuantity,uint64 instrumentId,uint8 bidOrAsk,uint256 nonce,uint256 deadline)"
    );

    bytes32 private constant DEPOSIT_TYPEHASH =
        keccak256("Deposit(address asset,uint256 amount,uint256 nonce,uint256 deadline)");

    bytes32 private constant WITHDRAWAL_TYPEHASH =
        keccak256("Withdrawal(address asset,uint256 amount,uint256 nonce,uint256 deadline)");

    bytes32 private constant ADD_INSTRUMENT_TYPEHASH = keccak256(
        "AddInstrument(uint64 instrumentId,address base,address quote,uint8 baseLotExp,uint8 quoteLotExp,uint256 nonce,uint256 deadline)"
    );

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

    function execute(Bundle[] calldata bundles) external {
        if (msg.sender != SCHEDULER) revert Unauthorized();

        for (uint256 b = 0; b < bundles.length;) {
            Bundle calldata bundle = bundles[b];

            if (
                bundle.mutations.length != bundle.mutationData.length
                    || bundle.mutations.length != bundle.signatures.length
            ) {
                revert LengthMismatch();
            }

            Mutation prev = Mutation.Initialize;
            for (uint256 i = 0; i < bundle.mutations.length;) {
                Mutation mutation = bundle.mutations[i];
                if (mutation < prev) revert MutationsOutOfOrder();
                prev = mutation;

                bytes calldata data = bundle.mutationData[i];
                Signature calldata sig = bundle.signatures[i];

                if (mutation == Mutation.Initialize) {
                    Initialize memory init = abi.decode(data, (Initialize));
                    Account storage acc = state.accounts[sig.account];
                    if (acc.keys.length != 0) revert AlreadyInitialized();

                    bytes32 structHash = keccak256(
                        abi.encode(
                            INITIALIZE_TYPEHASH,
                            init.account,
                            init.expiry,
                            init.rootKeyType,
                            init.keyType,
                            init.permissions,
                            keccak256(init.rootPublicKey),
                            keccak256(init.publicKey)
                        )
                    );
                    bytes32 digest = keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR(), structHash));
                    verifySignature(KeyType(init.rootKeyType), digest, init.rootPublicKey, sig.rawSignature);

                    acc.keys.push(Key(0, KeyType(init.rootKeyType), type(uint8).max, init.rootPublicKey));
                    acc.keys.push(Key(init.expiry, KeyType(init.keyType), init.permissions, init.publicKey));
                } else if (mutation == Mutation.Authorize) {
                    Authorize memory auth = abi.decode(data, (Authorize));
                    uint8 permissions = _verifySig(
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
                        ),
                        auth.nonce,
                        auth.deadline,
                        sig
                    );
                    if ((permissions & PERM_AUTHORIZE) == 0) revert Unauthorized();
                    state.accounts[sig.account].keys
                        .push(Key(auth.expiry, KeyType(auth.keyType), auth.permissions, auth.publicKey));
                } else if (mutation == Mutation.Revoke) {
                    Revoke memory rev = abi.decode(data, (Revoke));
                    uint8 permissions = _verifySig(
                        keccak256(abi.encode(REVOKE_TYPEHASH, rev.account, rev.keyId, rev.nonce, rev.deadline)),
                        rev.nonce,
                        rev.deadline,
                        sig
                    );
                    if ((permissions & PERM_REVOKE) == 0) revert Unauthorized();
                    delete state.accounts[sig.account].keys[rev.keyId];
                } else if (mutation == Mutation.CloseOrder) {
                    CloseOrder memory close = abi.decode(data, (CloseOrder));
                    uint8 permissions = _verifySig(
                        keccak256(abi.encode(CLOSE_ORDER_TYPEHASH, close.orderId, close.nonce, close.deadline)),
                        close.nonce,
                        close.deadline,
                        sig
                    );
                    if ((permissions & PERM_CLOSE_ORDER) == 0) revert Unauthorized();
                    _executeCloseOrder(close, sig.account);
                } else if (mutation == Mutation.LimitOrder) {
                    LimitOrder memory order = abi.decode(data, (LimitOrder));
                    uint8 permissions = _verifySig(
                        keccak256(
                            abi.encode(
                                LIMIT_ORDER_TYPEHASH,
                                order.quantity,
                                order.instrumentId,
                                order.price,
                                order.bidOrAsk,
                                order.nonce,
                                order.deadline
                            )
                        ),
                        order.nonce,
                        order.deadline,
                        sig
                    );
                    if ((permissions & PERM_LIMIT_ORDER) == 0) revert Unauthorized();
                    _executeLimitOrder(order, sig.account);
                } else if (mutation == Mutation.MarketOrder) {
                    (MarketOrder memory order, MarketOrderResolution memory resolution) =
                        abi.decode(data, (MarketOrder, MarketOrderResolution));
                    uint8 permissions = _verifySig(
                        keccak256(
                            abi.encode(
                                MARKET_ORDER_TYPEHASH,
                                order.quantity,
                                order.minReceivedQuantity,
                                order.instrumentId,
                                order.bidOrAsk,
                                order.nonce,
                                order.deadline
                            )
                        ),
                        order.nonce,
                        order.deadline,
                        sig
                    );
                    if ((permissions & PERM_MARKET_ORDER) == 0) revert Unauthorized();
                    _executeMarketOrder(order, resolution, sig.account);
                } else if (mutation == Mutation.AddInstrument) {
                    AddInstrument memory p = abi.decode(data, (AddInstrument));
                    uint8 permissions = _verifySig(
                        keccak256(
                            abi.encode(
                                ADD_INSTRUMENT_TYPEHASH,
                                p.instrumentId,
                                p.base,
                                p.quote,
                                p.baseLotExp,
                                p.quoteLotExp,
                                p.nonce,
                                p.deadline
                            )
                        ),
                        p.nonce,
                        p.deadline,
                        sig
                    );
                    if ((permissions & PERM_ADD_INSTRUMENT) == 0) revert Unauthorized();
                    if (p.baseLotExp > 128 || p.quoteLotExp > 128) revert LotExpTooLarge();
                    Instrument storage inst = state.instruments[p.instrumentId];
                    if (inst.base != address(0)) revert InstrumentAlreadyExists();
                    inst.base = p.base;
                    inst.quote = p.quote;
                    inst.baseLotExp = p.baseLotExp;
                    inst.quoteLotExp = p.quoteLotExp;
                } else if (mutation == Mutation.Deposit) {
                    Deposit memory d = abi.decode(data, (Deposit));
                    uint8 permissions = _verifySig(
                        keccak256(abi.encode(DEPOSIT_TYPEHASH, d.asset, d.amount, d.nonce, d.deadline)),
                        d.nonce,
                        d.deadline,
                        sig
                    );
                    if ((permissions & PERM_DEPOSIT) == 0) revert Unauthorized();
                    state.accounts[sig.account].balances[d.asset] += d.amount;
                } else if (mutation == Mutation.Withdrawal) {
                    Withdrawal memory w = abi.decode(data, (Withdrawal));
                    uint8 permissions = _verifySig(
                        keccak256(abi.encode(WITHDRAWAL_TYPEHASH, w.asset, w.amount, w.nonce, w.deadline)),
                        w.nonce,
                        w.deadline,
                        sig
                    );
                    if ((permissions & PERM_WITHDRAW) == 0) revert Unauthorized();
                    if (state.accounts[sig.account].balances[w.asset] < w.amount) revert InsufficientBalance();
                    unchecked {
                        state.accounts[sig.account].balances[w.asset] -= w.amount;
                    }
                } else {
                    revert InvalidMutation();
                }
                unchecked {
                    ++i;
                }
            }
            unchecked {
                ++b;
            }
        }
    }

    function _verifySig(bytes32 structHash, uint256 nonce, uint256 deadline, Signature calldata sig)
        internal
        returns (uint8 permissions)
    {
        if (deadline < block.timestamp) revert SignatureExpired();

        Account storage acc = state.accounts[sig.account];
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR(), structHash));
        permissions = verify(acc.keys, digest, sig.keyId, sig.rawSignature);

        uint192 nonceKey = uint192(nonce >> 64);
        uint64 nonceSeq = uint64(nonce);
        uint64 stored = acc.nonces[nonceKey];
        if (nonceSeq != stored) revert InvalidNonce();
        unchecked {
            acc.nonces[nonceKey] = stored + 1;
        }
    }

    function _settleFill(Fill memory fill, Instrument storage instrument, uint8 takerSide, bytes32 takerAccount)
        internal
    {
        mapping(uint64 => Tick) storage ticks = takerSide == 0 ? instrument.asks : instrument.bids;

        Tick storage tick = ticks[fill.price];

        if (fill.quantity > tick.remainingQuantity) revert InvalidTick();

        unchecked {
            tick.remainingQuantity -= fill.quantity;
        }
        if (tick.remainingQuantity == 0) {
            tick.volume++;
            tick.quantity = 0;
        }

        address base = instrument.base;
        address quote = instrument.quote;
        uint256 rawBase = uint256(fill.quantity) << instrument.baseLotExp;
        uint256 rawQuote = ((uint256(fill.quantity) * uint256(fill.price)) >> 32) << instrument.quoteLotExp;
        Account storage taker = state.accounts[takerAccount];

        if (takerSide == 0) {
            if (taker.balances[quote] < rawQuote) revert InsufficientBalance();
            unchecked {
                taker.balances[quote] -= rawQuote;
            }
            taker.balances[base] += rawBase;
        } else {
            if (taker.balances[base] < rawBase) revert InsufficientBalance();
            unchecked {
                taker.balances[base] -= rawBase;
            }
            taker.balances[quote] += rawQuote;
        }
    }

    function _executeMarketOrder(MarketOrder memory order, MarketOrderResolution memory res, bytes32 account) internal {
        Instrument storage instrument = state.instruments[order.instrumentId];
        if (instrument.base == address(0)) revert InvalidInstrument();

        uint64 quantityLots = _toLots(order.quantity, instrument.baseLotExp);
        uint8 receivedLotExp = order.bidOrAsk == 0 ? instrument.baseLotExp : instrument.quoteLotExp;
        uint64 minReceivedLots = _toLots(order.minReceivedQuantity, receivedLotExp);

        uint256 totalFilled;
        uint256 totalReceived;
        for (uint256 i = 0; i < res.fills.length;) {
            Fill memory fill = res.fills[i];
            _settleFill(fill, instrument, order.bidOrAsk, account);

            unchecked {
                totalFilled += fill.quantity;
                if (order.bidOrAsk == 0) {
                    totalReceived += fill.quantity;
                } else {
                    totalReceived += (uint256(fill.quantity) * uint256(fill.price)) >> 32;
                }
                ++i;
            }
        }

        if (totalFilled != quantityLots) revert InvalidMutation();
        if (totalReceived < minReceivedLots) revert SlippageExceeded();
    }

    function _executeLimitOrder(LimitOrder memory order, bytes32 account) internal {
        Instrument storage instrument = state.instruments[order.instrumentId];
        address base = instrument.base;
        if (base == address(0)) revert InvalidInstrument();

        uint8 baseLotExp = instrument.baseLotExp;
        uint64 quantityLots = _toLots(order.quantity, baseLotExp);

        mapping(uint64 => Tick) storage ticks = order.bidOrAsk == 0 ? instrument.bids : instrument.asks;
        Tick storage tick = ticks[order.price];

        uint64 currentQuantity = tick.quantity;
        if (tick.remainingQuantity != currentQuantity) revert TickPartiallyFilled();

        Account storage acc = state.accounts[account];
        if (order.bidOrAsk == 0) {
            address quote = instrument.quote;
            uint256 rawLock = ((uint256(quantityLots) * uint256(order.price)) >> 32) << instrument.quoteLotExp;
            if (acc.balances[quote] < rawLock) revert InsufficientBalance();
            unchecked {
                acc.balances[quote] -= rawLock;
            }
        } else {
            uint256 rawBase = uint256(quantityLots) << baseLotExp;
            if (acc.balances[base] < rawBase) revert InsufficientBalance();
            unchecked {
                acc.balances[base] -= rawBase;
            }
        }

        uint64 newQuantity = currentQuantity + quantityLots;
        tick.quantity = newQuantity;
        tick.remainingQuantity = newQuantity;

        acc.orders
            .push(
                Order({
                    quantity: quantityLots,
                    instrumentId: order.instrumentId,
                    price: order.price,
                    tickVolume: tick.volume,
                    side: order.bidOrAsk
                })
            );
    }

    function _executeCloseOrder(CloseOrder memory close, bytes32 account) internal {
        Account storage acc = state.accounts[account];
        Order storage order = acc.orders[close.orderId];
        uint64 orderQuantity = order.quantity;
        if (orderQuantity == 0) revert OrderNotFound();

        uint64 orderPrice = order.price;
        uint8 orderSide = order.side;
        Instrument storage instrument = state.instruments[order.instrumentId];
        mapping(uint64 => Tick) storage ticks = orderSide == 0 ? instrument.bids : instrument.asks;
        Tick storage tick = ticks[orderPrice];

        uint64 filledQuantity;
        uint64 unfilledQuantity;
        if (tick.volume > order.tickVolume) {
            filledQuantity = orderQuantity;
        } else {
            // tick.quantity != 0 here: a fully-swept tick increments volume, which the branch above catches.
            unchecked {
                uint256 consumed = tick.quantity - tick.remainingQuantity;
                filledQuantity = uint64((uint256(orderQuantity) * consumed) / tick.quantity);
                unfilledQuantity = orderQuantity - filledQuantity;
            }
        }

        if (unfilledQuantity > 0) {
            // unfilledQuantity <= tick.remainingQuantity: this order's unfilled share is bounded by the tick's total unfilled.
            unchecked {
                tick.quantity -= unfilledQuantity;
                tick.remainingQuantity -= unfilledQuantity;
            }
        }

        if (orderSide == 0) {
            acc.balances[
                    instrument.quote
                ] += ((uint256(unfilledQuantity) * uint256(orderPrice)) >> 32) << instrument.quoteLotExp;
            acc.balances[instrument.base] += uint256(filledQuantity) << instrument.baseLotExp;
        } else {
            acc.balances[instrument.base] += uint256(unfilledQuantity) << instrument.baseLotExp;
            acc.balances[
                    instrument.quote
                ] += ((uint256(filledQuantity) * uint256(orderPrice)) >> 32) << instrument.quoteLotExp;
        }

        delete acc.orders[close.orderId];
    }

    function _computeDomainSeparator() private view returns (bytes32) {
        return keccak256(
            abi.encode(EIP712_DOMAIN_TYPEHASH, keccak256("Exchange"), keccak256("1"), block.chainid, address(this))
        );
    }

    function _toLots(uint256 fullAmount, uint8 lotExp) internal pure returns (uint64) {
        uint256 lots = fullAmount >> lotExp;
        if (lots << lotExp != fullAmount) revert AmountNotLotMultiple();
        if (lots > type(uint64).max) revert AmountNotLotMultiple();
        return uint64(lots);
    }
}
