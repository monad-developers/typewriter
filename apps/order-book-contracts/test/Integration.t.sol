// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";

import {
    Exchange,
    ExecuteParams,
    Mutation,
    AddInstrumentParams,
    Deposit,
    Withdrawal,
    LimitOrder,
    MarketOrder,
    MarketOrderResolution,
    CloseOrder,
    Fill,
    MutationsOutOfOrder,
    SignatureExpired,
    InvalidNonce,
    InvalidSignature,
    InsufficientBalance
} from "src/Exchange.sol";

contract IntegrationTest is Test, Exchange(address(0xBEEF)) {
    address constant SCHEDULER = address(0xBEEF);
    address constant BASE = address(0x1);
    address constant QUOTE = address(0x2);
    uint64 constant Q32 = 1 << 32;

    uint256 makerPk = 0xA11CE;
    uint256 takerPk = 0xB0B;
    address maker;
    address taker;

    bytes32 constant _DEPOSIT_TYPEHASH =
        keccak256("Deposit(address asset,uint256 amount,uint256 nonce,uint256 deadline)");
    bytes32 constant _WITHDRAWAL_TYPEHASH =
        keccak256("Withdrawal(address asset,uint256 amount,uint256 nonce,uint256 deadline)");
    bytes32 constant _LIMIT_ORDER_TYPEHASH =
        keccak256("LimitOrder(uint64 quantity,uint64 instrumentId,uint64 price,uint8 bidOrAsk,uint256 nonce,uint256 deadline)");
    bytes32 constant _MARKET_ORDER_TYPEHASH =
        keccak256("MarketOrder(uint64 quantity,uint64 minReceivedQuantity,uint64 instrumentId,uint8 bidOrAsk,uint256 nonce,uint256 deadline)");
    bytes32 constant _CLOSE_ORDER_TYPEHASH =
        keccak256("CloseOrder(uint64 orderId,uint256 nonce,uint256 deadline)");

    function setUp() public {
        maker = vm.addr(makerPk);
        taker = vm.addr(takerPk);
    }

    function _sign(uint256 pk, bytes32 structHash) internal view returns (uint8, bytes32, bytes32) {
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR(), structHash));
        return vm.sign(pk, digest);
    }

    function _exec(
        Mutation[] memory mutations,
        bytes[] memory data,
        uint8[] memory v,
        bytes32[] memory r,
        bytes32[] memory s
    ) internal {
        vm.prank(SCHEDULER);
        this.execute(ExecuteParams({
            mutations: mutations,
            mutationData: data,
            v: v,
            r: r,
            s: s
        }));
    }

    function _setupInstrument() internal {
        Mutation[] memory muts = new Mutation[](1);
        bytes[] memory data = new bytes[](1);
        uint8[] memory v = new uint8[](1);
        bytes32[] memory r = new bytes32[](1);
        bytes32[] memory s = new bytes32[](1);

        muts[0] = Mutation.AddInstrument;
        data[0] = abi.encode(AddInstrumentParams({
            instrumentId: 0, base: BASE, quote: QUOTE, baseLotExp: 0, quoteLotExp: 0
        }));

        _exec(muts, data, v, r, s);
    }

    function _deposit(uint256 pk, uint256 nonce, address asset, uint256 amount) internal {
        Mutation[] memory muts = new Mutation[](1);
        bytes[] memory data = new bytes[](1);
        uint8[] memory v = new uint8[](1);
        bytes32[] memory r = new bytes32[](1);
        bytes32[] memory s = new bytes32[](1);

        muts[0] = Mutation.Deposit;
        Deposit memory d = Deposit({asset: asset, amount: amount, nonce: nonce, deadline: type(uint256).max});
        data[0] = abi.encode(d);
        (v[0], r[0], s[0]) = _sign(pk, keccak256(abi.encode(
            _DEPOSIT_TYPEHASH, d.asset, d.amount, d.nonce, d.deadline
        )));

        _exec(muts, data, v, r, s);
    }

    function _placeLimitOrder(uint256 pk, uint256 nonce, uint64 quantity, uint64 price, uint8 bidOrAsk) internal {
        Mutation[] memory muts = new Mutation[](1);
        bytes[] memory data = new bytes[](1);
        uint8[] memory v = new uint8[](1);
        bytes32[] memory r = new bytes32[](1);
        bytes32[] memory s = new bytes32[](1);

        muts[0] = Mutation.LimitOrder;
        LimitOrder memory order = LimitOrder({
            quantity: quantity, instrumentId: 0, price: price, bidOrAsk: bidOrAsk, nonce: nonce, deadline: type(uint256).max
        });
        data[0] = abi.encode(order);
        (v[0], r[0], s[0]) = _sign(pk, keccak256(abi.encode(
            _LIMIT_ORDER_TYPEHASH, order.quantity, order.instrumentId, order.price, order.bidOrAsk, order.nonce, order.deadline
        )));

        _exec(muts, data, v, r, s);
    }

    function test_LimitOrder_Cold() external {
        vm.pauseGasMetering();

        _setupInstrument();
        _deposit(makerPk, 0, QUOTE, 10000);

        Mutation[] memory muts = new Mutation[](1);
        bytes[] memory data = new bytes[](1);
        uint8[] memory v = new uint8[](1);
        bytes32[] memory r = new bytes32[](1);
        bytes32[] memory s = new bytes32[](1);

        muts[0] = Mutation.LimitOrder;
        LimitOrder memory order = LimitOrder({
            quantity: 10, instrumentId: 0, price: 10 * Q32, bidOrAsk: 0, nonce: 1, deadline: type(uint256).max
        });
        data[0] = abi.encode(order);
        (v[0], r[0], s[0]) = _sign(makerPk, keccak256(abi.encode(
            _LIMIT_ORDER_TYPEHASH, order.quantity, order.instrumentId, order.price, order.bidOrAsk, order.nonce, order.deadline
        )));

        vm.resumeGasMetering();

        _exec(muts, data, v, r, s);

        vm.pauseGasMetering();

        assertEq(state.accounts[maker].balances[QUOTE], 9900);
        assertEq(state.accounts[maker].orders.length, 1);
        assertEq(state.accounts[maker].orders[0].quantity, 10);
        assertEq(state.instruments[0].bids[10 * Q32].quantity, 10);
        assertEq(state.instruments[0].bids[10 * Q32].remainingQuantity, 10);
        assertEq(state.accounts[maker].nonce, 2);

        vm.resumeGasMetering();
    }

    function test_LimitOrder_Hot() external {
        vm.pauseGasMetering();

        _setupInstrument();
        _deposit(makerPk, 0, QUOTE, 10000);
        _placeLimitOrder(makerPk, 1, 10, 10 * Q32, 0);

        Mutation[] memory muts = new Mutation[](1);
        bytes[] memory data = new bytes[](1);
        uint8[] memory v = new uint8[](1);
        bytes32[] memory r = new bytes32[](1);
        bytes32[] memory s = new bytes32[](1);

        muts[0] = Mutation.LimitOrder;
        LimitOrder memory order = LimitOrder({
            quantity: 5, instrumentId: 0, price: 20 * Q32, bidOrAsk: 0, nonce: 2, deadline: type(uint256).max
        });
        data[0] = abi.encode(order);
        (v[0], r[0], s[0]) = _sign(makerPk, keccak256(abi.encode(
            _LIMIT_ORDER_TYPEHASH, order.quantity, order.instrumentId, order.price, order.bidOrAsk, order.nonce, order.deadline
        )));

        vm.resumeGasMetering();

        _exec(muts, data, v, r, s);

        vm.pauseGasMetering();

        assertEq(state.accounts[maker].balances[QUOTE], 9900 - 100);
        assertEq(state.accounts[maker].orders.length, 2);
        assertEq(state.accounts[maker].orders[1].quantity, 5);
        assertEq(state.instruments[0].bids[20 * Q32].quantity, 5);

        vm.resumeGasMetering();
    }

    function test_MarketOrder_Cold() external {
        vm.pauseGasMetering();

        _setupInstrument();
        _deposit(makerPk, 0, QUOTE, 10000);
        _deposit(takerPk, 0, BASE, 10000);
        _placeLimitOrder(makerPk, 1, 100, 10 * Q32, 0);

        Mutation[] memory muts = new Mutation[](1);
        bytes[] memory data = new bytes[](1);
        uint8[] memory v = new uint8[](1);
        bytes32[] memory r = new bytes32[](1);
        bytes32[] memory s = new bytes32[](1);

        Fill[] memory fills = new Fill[](1);
        fills[0] = Fill({quantity: 10, price: 10 * Q32});

        muts[0] = Mutation.MarketOrder;
        MarketOrder memory order = MarketOrder({
            quantity: 10, minReceivedQuantity: 0, instrumentId: 0, bidOrAsk: 1, nonce: 1, deadline: type(uint256).max
        });
        data[0] = abi.encode(order, MarketOrderResolution({fills: fills}));
        (v[0], r[0], s[0]) = _sign(takerPk, keccak256(abi.encode(
            _MARKET_ORDER_TYPEHASH, order.quantity, order.minReceivedQuantity, order.instrumentId, order.bidOrAsk, order.nonce, order.deadline
        )));

        vm.resumeGasMetering();

        _exec(muts, data, v, r, s);

        vm.pauseGasMetering();

        assertEq(state.accounts[taker].balances[BASE], 9990);
        assertEq(state.accounts[taker].balances[QUOTE], 100);
        assertEq(state.instruments[0].bids[10 * Q32].remainingQuantity, 90);
        assertEq(state.accounts[taker].nonce, 2);

        vm.resumeGasMetering();
    }

    function test_MarketOrder_Hot() external {
        vm.pauseGasMetering();

        _setupInstrument();
        _deposit(makerPk, 0, QUOTE, 10000);
        _deposit(takerPk, 0, BASE, 10000);
        _placeLimitOrder(makerPk, 1, 100, 10 * Q32, 0);

        Fill[] memory coldFills = new Fill[](1);
        coldFills[0] = Fill({quantity: 10, price: 10 * Q32});

        {
            Mutation[] memory m = new Mutation[](1);
            bytes[] memory d = new bytes[](1);
            uint8[] memory _v = new uint8[](1);
            bytes32[] memory _r = new bytes32[](1);
            bytes32[] memory _s = new bytes32[](1);

            m[0] = Mutation.MarketOrder;
            MarketOrder memory coldOrder = MarketOrder({
                quantity: 10, minReceivedQuantity: 0, instrumentId: 0, bidOrAsk: 1, nonce: 1, deadline: type(uint256).max
            });
            d[0] = abi.encode(coldOrder, MarketOrderResolution({fills: coldFills}));
            (_v[0], _r[0], _s[0]) = _sign(takerPk, keccak256(abi.encode(
                _MARKET_ORDER_TYPEHASH, coldOrder.quantity, coldOrder.minReceivedQuantity, coldOrder.instrumentId, coldOrder.bidOrAsk, coldOrder.nonce, coldOrder.deadline
            )));
            _exec(m, d, _v, _r, _s);
        }

        Mutation[] memory muts = new Mutation[](1);
        bytes[] memory data = new bytes[](1);
        uint8[] memory v = new uint8[](1);
        bytes32[] memory r = new bytes32[](1);
        bytes32[] memory s = new bytes32[](1);

        Fill[] memory fills = new Fill[](1);
        fills[0] = Fill({quantity: 5, price: 10 * Q32});

        muts[0] = Mutation.MarketOrder;
        MarketOrder memory order = MarketOrder({
            quantity: 5, minReceivedQuantity: 0, instrumentId: 0, bidOrAsk: 1, nonce: 2, deadline: type(uint256).max
        });
        data[0] = abi.encode(order, MarketOrderResolution({fills: fills}));
        (v[0], r[0], s[0]) = _sign(takerPk, keccak256(abi.encode(
            _MARKET_ORDER_TYPEHASH, order.quantity, order.minReceivedQuantity, order.instrumentId, order.bidOrAsk, order.nonce, order.deadline
        )));

        vm.resumeGasMetering();

        _exec(muts, data, v, r, s);

        vm.pauseGasMetering();

        assertEq(state.accounts[taker].balances[BASE], 9985);
        assertEq(state.accounts[taker].balances[QUOTE], 150);
        assertEq(state.instruments[0].bids[10 * Q32].remainingQuantity, 85);

        vm.resumeGasMetering();
    }

    function test_CloseOrder_Cold() external {
        vm.pauseGasMetering();

        _setupInstrument();
        _deposit(makerPk, 0, QUOTE, 10000);
        _placeLimitOrder(makerPk, 1, 50, 10 * Q32, 0);

        Mutation[] memory muts = new Mutation[](1);
        bytes[] memory data = new bytes[](1);
        uint8[] memory v = new uint8[](1);
        bytes32[] memory r = new bytes32[](1);
        bytes32[] memory s = new bytes32[](1);

        muts[0] = Mutation.CloseOrder;
        CloseOrder memory close = CloseOrder({orderId: 0, nonce: 2, deadline: type(uint256).max});
        data[0] = abi.encode(close);
        (v[0], r[0], s[0]) = _sign(makerPk, keccak256(abi.encode(
            _CLOSE_ORDER_TYPEHASH, close.orderId, close.nonce, close.deadline
        )));

        vm.resumeGasMetering();

        _exec(muts, data, v, r, s);

        vm.pauseGasMetering();

        assertEq(state.accounts[maker].balances[QUOTE], 10000);
        assertEq(state.accounts[maker].orders[0].quantity, 0);
        assertEq(state.instruments[0].bids[10 * Q32].quantity, 0);

        vm.resumeGasMetering();
    }

    function test_Withdrawal_Cold() external {
        vm.pauseGasMetering();

        _setupInstrument();
        _deposit(makerPk, 0, QUOTE, 10000);

        Mutation[] memory muts = new Mutation[](1);
        bytes[] memory data = new bytes[](1);
        uint8[] memory v = new uint8[](1);
        bytes32[] memory r = new bytes32[](1);
        bytes32[] memory s = new bytes32[](1);

        muts[0] = Mutation.Withdrawal;
        Withdrawal memory w = Withdrawal({asset: QUOTE, amount: 3000, nonce: 1, deadline: type(uint256).max});
        data[0] = abi.encode(w);
        (v[0], r[0], s[0]) = _sign(makerPk, keccak256(abi.encode(
            _WITHDRAWAL_TYPEHASH, w.asset, w.amount, w.nonce, w.deadline
        )));

        vm.resumeGasMetering();

        _exec(muts, data, v, r, s);

        vm.pauseGasMetering();

        assertEq(state.accounts[maker].balances[QUOTE], 7000);

        vm.resumeGasMetering();
    }

    function test_MakerSettlement() external {
        vm.pauseGasMetering();

        _setupInstrument();
        _deposit(makerPk, 0, QUOTE, 10000);
        _deposit(takerPk, 0, BASE, 10000);
        _placeLimitOrder(makerPk, 1, 100, 10 * Q32, 0);

        {
            Mutation[] memory m = new Mutation[](1);
            bytes[] memory d = new bytes[](1);
            uint8[] memory _v = new uint8[](1);
            bytes32[] memory _r = new bytes32[](1);
            bytes32[] memory _s = new bytes32[](1);

            Fill[] memory fills = new Fill[](1);
            fills[0] = Fill({quantity: 40, price: 10 * Q32});

            m[0] = Mutation.MarketOrder;
            MarketOrder memory mo = MarketOrder({
                quantity: 40, minReceivedQuantity: 0, instrumentId: 0, bidOrAsk: 1, nonce: 1, deadline: type(uint256).max
            });
            d[0] = abi.encode(mo, MarketOrderResolution({fills: fills}));
            (_v[0], _r[0], _s[0]) = _sign(takerPk, keccak256(abi.encode(
                _MARKET_ORDER_TYPEHASH, mo.quantity, mo.minReceivedQuantity, mo.instrumentId, mo.bidOrAsk, mo.nonce, mo.deadline
            )));
            _exec(m, d, _v, _r, _s);
        }

        assertEq(state.accounts[taker].balances[BASE], 9960);
        assertEq(state.accounts[taker].balances[QUOTE], 400);

        Mutation[] memory muts = new Mutation[](1);
        bytes[] memory data = new bytes[](1);
        uint8[] memory v = new uint8[](1);
        bytes32[] memory r = new bytes32[](1);
        bytes32[] memory s = new bytes32[](1);

        muts[0] = Mutation.CloseOrder;
        CloseOrder memory close = CloseOrder({orderId: 0, nonce: 2, deadline: type(uint256).max});
        data[0] = abi.encode(close);
        (v[0], r[0], s[0]) = _sign(makerPk, keccak256(abi.encode(
            _CLOSE_ORDER_TYPEHASH, close.orderId, close.nonce, close.deadline
        )));

        vm.resumeGasMetering();

        _exec(muts, data, v, r, s);

        vm.pauseGasMetering();

        assertEq(state.accounts[maker].balances[QUOTE], 10000 - 1000 + 600);
        assertEq(state.accounts[maker].balances[BASE], 40);

        vm.resumeGasMetering();
    }

    function test_MutationsOutOfOrder() external {
        Mutation[] memory muts = new Mutation[](2);
        bytes[] memory data = new bytes[](2);
        uint8[] memory v = new uint8[](2);
        bytes32[] memory r = new bytes32[](2);
        bytes32[] memory s = new bytes32[](2);

        muts[0] = Mutation.AddInstrument;
        data[0] = abi.encode(AddInstrumentParams({
            instrumentId: 0, base: BASE, quote: QUOTE, baseLotExp: 0, quoteLotExp: 0
        }));

        muts[1] = Mutation.CloseOrder;
        data[1] = abi.encode(CloseOrder({orderId: 0, nonce: 0, deadline: type(uint256).max}));

        vm.prank(SCHEDULER);
        vm.expectRevert(MutationsOutOfOrder.selector);
        this.execute(ExecuteParams({mutations: muts, mutationData: data, v: v, r: r, s: s}));
    }

    function test_SignatureExpired() external {
        vm.pauseGasMetering();

        _setupInstrument();

        Mutation[] memory muts = new Mutation[](1);
        bytes[] memory data = new bytes[](1);
        uint8[] memory v = new uint8[](1);
        bytes32[] memory r = new bytes32[](1);
        bytes32[] memory s = new bytes32[](1);

        muts[0] = Mutation.Deposit;
        Deposit memory d = Deposit({asset: QUOTE, amount: 100, nonce: 0, deadline: 0});
        data[0] = abi.encode(d);
        (v[0], r[0], s[0]) = _sign(makerPk, keccak256(abi.encode(
            _DEPOSIT_TYPEHASH, d.asset, d.amount, d.nonce, d.deadline
        )));

        vm.warp(1);

        vm.resumeGasMetering();

        vm.prank(SCHEDULER);
        vm.expectRevert(SignatureExpired.selector);
        this.execute(ExecuteParams({mutations: muts, mutationData: data, v: v, r: r, s: s}));
    }

    function test_InvalidNonce() external {
        vm.pauseGasMetering();

        _setupInstrument();

        Mutation[] memory muts = new Mutation[](1);
        bytes[] memory data = new bytes[](1);
        uint8[] memory v = new uint8[](1);
        bytes32[] memory r = new bytes32[](1);
        bytes32[] memory s = new bytes32[](1);

        muts[0] = Mutation.Deposit;
        Deposit memory d = Deposit({asset: QUOTE, amount: 100, nonce: 99, deadline: type(uint256).max});
        data[0] = abi.encode(d);
        (v[0], r[0], s[0]) = _sign(makerPk, keccak256(abi.encode(
            _DEPOSIT_TYPEHASH, d.asset, d.amount, d.nonce, d.deadline
        )));

        vm.resumeGasMetering();

        vm.prank(SCHEDULER);
        vm.expectRevert(InvalidNonce.selector);
        this.execute(ExecuteParams({mutations: muts, mutationData: data, v: v, r: r, s: s}));
    }

    function test_InvalidSignature_ZeroRecovery() external {
        vm.pauseGasMetering();

        _setupInstrument();

        Mutation[] memory muts = new Mutation[](1);
        bytes[] memory data = new bytes[](1);
        uint8[] memory v = new uint8[](1);
        bytes32[] memory r = new bytes32[](1);
        bytes32[] memory s = new bytes32[](1);

        muts[0] = Mutation.Deposit;
        data[0] = abi.encode(Deposit({asset: QUOTE, amount: 100, nonce: 0, deadline: type(uint256).max}));

        vm.resumeGasMetering();

        vm.prank(SCHEDULER);
        vm.expectRevert(InvalidSignature.selector);
        this.execute(ExecuteParams({mutations: muts, mutationData: data, v: v, r: r, s: s}));
    }

    function test_InvalidSignature_WrongKey() external {
        vm.pauseGasMetering();

        _setupInstrument();
        _deposit(makerPk, 0, QUOTE, 100);

        Mutation[] memory muts = new Mutation[](1);
        bytes[] memory data = new bytes[](1);
        uint8[] memory v = new uint8[](1);
        bytes32[] memory r = new bytes32[](1);
        bytes32[] memory s = new bytes32[](1);

        muts[0] = Mutation.Withdrawal;
        Withdrawal memory w = Withdrawal({asset: QUOTE, amount: 100, nonce: 1, deadline: type(uint256).max});
        data[0] = abi.encode(w);
        (v[0], r[0], s[0]) = _sign(takerPk, keccak256(abi.encode(
            _WITHDRAWAL_TYPEHASH, w.asset, w.amount, w.nonce, w.deadline
        )));

        vm.resumeGasMetering();

        vm.prank(SCHEDULER);
        vm.expectRevert(InvalidNonce.selector);
        this.execute(ExecuteParams({mutations: muts, mutationData: data, v: v, r: r, s: s}));
    }
}
