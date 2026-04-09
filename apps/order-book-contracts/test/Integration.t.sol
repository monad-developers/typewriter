// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";

import {
    Exchange,
    ExecuteParams,
    Mutation,
    Signature,
    AddInstrumentParams,
    Deposit,
    Withdrawal,
    LimitOrder,
    MarketOrder,
    MarketOrderResolution,
    CloseOrder,
    Fill,
    PERM_AUTHORIZE,
    MutationsOutOfOrder,
    SignatureExpired,
    InvalidNonce
} from "src/Exchange.sol";

import {
    KeyType,
    Initialize,
    InvalidSignature,
    KeyNotFound,
    INITIALIZE_TYPEHASH
} from "src/Account.sol";

contract IntegrationTest is Test, Exchange(address(0xBEEF)) {
    address constant BASE = address(0x1);
    address constant QUOTE = address(0x2);
    uint64 constant Q32 = 1 << 32;

    uint256 makerPk = 0xA11CE;
    uint256 takerPk = 0xB0B;
    bytes32 makerAccount;
    bytes32 takerAccount;

    bytes32 constant _DEPOSIT_TYPEHASH =
        keccak256("Deposit(address asset,uint256 amount,uint256 nonce,uint256 deadline)");
    bytes32 constant _WITHDRAWAL_TYPEHASH =
        keccak256("Withdrawal(address asset,uint256 amount,uint256 nonce,uint256 deadline)");
    bytes32 constant _LIMIT_ORDER_TYPEHASH = keccak256(
        "LimitOrder(uint64 quantity,uint64 instrumentId,uint64 price,uint8 bidOrAsk,uint256 nonce,uint256 deadline)"
    );
    bytes32 constant _MARKET_ORDER_TYPEHASH = keccak256(
        "MarketOrder(uint64 quantity,uint64 minReceivedQuantity,uint64 instrumentId,uint8 bidOrAsk,uint256 nonce,uint256 deadline)"
    );
    bytes32 constant _CLOSE_ORDER_TYPEHASH =
        keccak256("CloseOrder(uint64 orderId,uint256 nonce,uint256 deadline)");

    function setUp() public {
        makerAccount = bytes32(uint256(uint160(vm.addr(makerPk))));
        takerAccount = bytes32(uint256(uint160(vm.addr(takerPk))));
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

    function _initAccount(uint256 pk, bytes32 acc) internal {
        Initialize memory init = Initialize({
            account: acc,
            expiry: 0,
            keyType: uint8(KeyType.Secp256k1),
            permissions: type(uint8).max,
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

    function _setupInstrument() internal {
        Mutation[] memory muts = new Mutation[](1);
        bytes[] memory data = new bytes[](1);
        Signature[] memory sigs = new Signature[](1);

        muts[0] = Mutation.AddInstrument;
        data[0] = abi.encode(
            AddInstrumentParams({instrumentId: 0, base: BASE, quote: QUOTE, baseLotExp: 0, quoteLotExp: 0})
        );

        _exec(muts, data, sigs);
    }

    function _deposit(uint256 pk, bytes32 acc, uint256 nonce, address asset, uint256 amount) internal {
        Mutation[] memory muts = new Mutation[](1);
        bytes[] memory data = new bytes[](1);
        Signature[] memory sigs = new Signature[](1);

        Deposit memory d = Deposit({asset: asset, amount: amount, nonce: nonce, deadline: type(uint256).max});
        muts[0] = Mutation.Deposit;
        data[0] = abi.encode(d);
        sigs[0] = Signature({
            account: acc,
            keyId: 0,
            rawSignature: _sign(pk, keccak256(abi.encode(_DEPOSIT_TYPEHASH, d.asset, d.amount, d.nonce, d.deadline)))
        });

        _exec(muts, data, sigs);
    }

    function _placeLimitOrder(uint256 pk, bytes32 acc, uint256 nonce, uint64 quantity, uint64 price, uint8 bidOrAsk)
        internal
    {
        Mutation[] memory muts = new Mutation[](1);
        bytes[] memory data = new bytes[](1);
        Signature[] memory sigs = new Signature[](1);

        LimitOrder memory order = LimitOrder({
            quantity: quantity,
            instrumentId: 0,
            price: price,
            bidOrAsk: bidOrAsk,
            nonce: nonce,
            deadline: type(uint256).max
        });
        muts[0] = Mutation.LimitOrder;
        data[0] = abi.encode(order);
        sigs[0] = Signature({
            account: acc,
            keyId: 0,
            rawSignature: _sign(
                pk,
                keccak256(
                    abi.encode(
                        _LIMIT_ORDER_TYPEHASH,
                        order.quantity,
                        order.instrumentId,
                        order.price,
                        order.bidOrAsk,
                        order.nonce,
                        order.deadline
                    )
                )
            )
        });

        _exec(muts, data, sigs);
    }

    function test_LimitOrder_Cold() external {
        vm.pauseGasMetering();

        _setupInstrument();
        _initAccount(makerPk, makerAccount);
        _deposit(makerPk, makerAccount, 0, QUOTE, 10000);

        Mutation[] memory muts = new Mutation[](1);
        bytes[] memory data = new bytes[](1);
        Signature[] memory sigs = new Signature[](1);

        LimitOrder memory order = LimitOrder({
            quantity: 10,
            instrumentId: 0,
            price: 10 * Q32,
            bidOrAsk: 0,
            nonce: 1,
            deadline: type(uint256).max
        });
        muts[0] = Mutation.LimitOrder;
        data[0] = abi.encode(order);
        sigs[0] = Signature({
            account: makerAccount,
            keyId: 0,
            rawSignature: _sign(
                makerPk,
                keccak256(
                    abi.encode(
                        _LIMIT_ORDER_TYPEHASH,
                        order.quantity,
                        order.instrumentId,
                        order.price,
                        order.bidOrAsk,
                        order.nonce,
                        order.deadline
                    )
                )
            )
        });

        vm.resumeGasMetering();

        _exec(muts, data, sigs);

        vm.pauseGasMetering();

        assertEq(state.accounts[makerAccount].balances[QUOTE], 9900);
        assertEq(state.accounts[makerAccount].orders.length, 1);
        assertEq(state.accounts[makerAccount].orders[0].quantity, 10);
        assertEq(state.instruments[0].bids[10 * Q32].quantity, 10);
        assertEq(state.instruments[0].bids[10 * Q32].remainingQuantity, 10);
        assertEq(state.accounts[makerAccount].nonces[0],2);

        vm.resumeGasMetering();
    }

    function test_LimitOrder_Hot() external {
        vm.pauseGasMetering();

        _setupInstrument();
        _initAccount(makerPk, makerAccount);
        _deposit(makerPk, makerAccount, 0, QUOTE, 10000);
        _placeLimitOrder(makerPk, makerAccount, 1, 10, 10 * Q32, 0);

        Mutation[] memory muts = new Mutation[](1);
        bytes[] memory data = new bytes[](1);
        Signature[] memory sigs = new Signature[](1);

        LimitOrder memory order = LimitOrder({
            quantity: 5,
            instrumentId: 0,
            price: 20 * Q32,
            bidOrAsk: 0,
            nonce: 2,
            deadline: type(uint256).max
        });
        muts[0] = Mutation.LimitOrder;
        data[0] = abi.encode(order);
        sigs[0] = Signature({
            account: makerAccount,
            keyId: 0,
            rawSignature: _sign(
                makerPk,
                keccak256(
                    abi.encode(
                        _LIMIT_ORDER_TYPEHASH,
                        order.quantity,
                        order.instrumentId,
                        order.price,
                        order.bidOrAsk,
                        order.nonce,
                        order.deadline
                    )
                )
            )
        });

        vm.resumeGasMetering();

        _exec(muts, data, sigs);

        vm.pauseGasMetering();

        assertEq(state.accounts[makerAccount].balances[QUOTE], 9900 - 100);
        assertEq(state.accounts[makerAccount].orders.length, 2);
        assertEq(state.accounts[makerAccount].orders[1].quantity, 5);
        assertEq(state.instruments[0].bids[20 * Q32].quantity, 5);

        vm.resumeGasMetering();
    }

    function test_MarketOrder_Cold() external {
        vm.pauseGasMetering();

        _setupInstrument();
        _initAccount(makerPk, makerAccount);
        _initAccount(takerPk, takerAccount);
        _deposit(makerPk, makerAccount, 0, QUOTE, 10000);
        _deposit(takerPk, takerAccount, 0, BASE, 10000);
        _placeLimitOrder(makerPk, makerAccount, 1, 100, 10 * Q32, 0);

        Mutation[] memory muts = new Mutation[](1);
        bytes[] memory data = new bytes[](1);
        Signature[] memory sigs = new Signature[](1);

        Fill[] memory fills = new Fill[](1);
        fills[0] = Fill({quantity: 10, price: 10 * Q32});

        MarketOrder memory order = MarketOrder({
            quantity: 10,
            minReceivedQuantity: 0,
            instrumentId: 0,
            bidOrAsk: 1,
            nonce: 1,
            deadline: type(uint256).max
        });
        muts[0] = Mutation.MarketOrder;
        data[0] = abi.encode(order, MarketOrderResolution({fills: fills}));
        sigs[0] = Signature({
            account: takerAccount,
            keyId: 0,
            rawSignature: _sign(
                takerPk,
                keccak256(
                    abi.encode(
                        _MARKET_ORDER_TYPEHASH,
                        order.quantity,
                        order.minReceivedQuantity,
                        order.instrumentId,
                        order.bidOrAsk,
                        order.nonce,
                        order.deadline
                    )
                )
            )
        });

        vm.resumeGasMetering();

        _exec(muts, data, sigs);

        vm.pauseGasMetering();

        assertEq(state.accounts[takerAccount].balances[BASE], 9990);
        assertEq(state.accounts[takerAccount].balances[QUOTE], 100);
        assertEq(state.instruments[0].bids[10 * Q32].remainingQuantity, 90);
        assertEq(state.accounts[takerAccount].nonces[0],2);

        vm.resumeGasMetering();
    }

    function test_MarketOrder_Hot() external {
        vm.pauseGasMetering();

        _setupInstrument();
        _initAccount(makerPk, makerAccount);
        _initAccount(takerPk, takerAccount);
        _deposit(makerPk, makerAccount, 0, QUOTE, 10000);
        _deposit(takerPk, takerAccount, 0, BASE, 10000);
        _placeLimitOrder(makerPk, makerAccount, 1, 100, 10 * Q32, 0);

        {
            Mutation[] memory m = new Mutation[](1);
            bytes[] memory d = new bytes[](1);
            Signature[] memory s = new Signature[](1);

            MarketOrder memory coldOrder = MarketOrder({
                quantity: 10,
                minReceivedQuantity: 0,
                instrumentId: 0,
                bidOrAsk: 1,
                nonce: 1,
                deadline: type(uint256).max
            });
            m[0] = Mutation.MarketOrder;
            d[0] = abi.encode(coldOrder, MarketOrderResolution({fills: new Fill[](1)}));
            Fill[] memory coldFills = new Fill[](1);
            coldFills[0] = Fill({quantity: 10, price: 10 * Q32});
            d[0] = abi.encode(coldOrder, MarketOrderResolution({fills: coldFills}));
            s[0] = Signature({
                account: takerAccount,
                keyId: 0,
                rawSignature: _sign(
                    takerPk,
                    keccak256(
                        abi.encode(
                            _MARKET_ORDER_TYPEHASH,
                            coldOrder.quantity,
                            coldOrder.minReceivedQuantity,
                            coldOrder.instrumentId,
                            coldOrder.bidOrAsk,
                            coldOrder.nonce,
                            coldOrder.deadline
                        )
                    )
                )
            });
            _exec(m, d, s);
        }

        Mutation[] memory muts = new Mutation[](1);
        bytes[] memory data = new bytes[](1);
        Signature[] memory sigs = new Signature[](1);

        Fill[] memory fills = new Fill[](1);
        fills[0] = Fill({quantity: 5, price: 10 * Q32});

        MarketOrder memory order = MarketOrder({
            quantity: 5,
            minReceivedQuantity: 0,
            instrumentId: 0,
            bidOrAsk: 1,
            nonce: 2,
            deadline: type(uint256).max
        });
        muts[0] = Mutation.MarketOrder;
        data[0] = abi.encode(order, MarketOrderResolution({fills: fills}));
        sigs[0] = Signature({
            account: takerAccount,
            keyId: 0,
            rawSignature: _sign(
                takerPk,
                keccak256(
                    abi.encode(
                        _MARKET_ORDER_TYPEHASH,
                        order.quantity,
                        order.minReceivedQuantity,
                        order.instrumentId,
                        order.bidOrAsk,
                        order.nonce,
                        order.deadline
                    )
                )
            )
        });

        vm.resumeGasMetering();

        _exec(muts, data, sigs);

        vm.pauseGasMetering();

        assertEq(state.accounts[takerAccount].balances[BASE], 9985);
        assertEq(state.accounts[takerAccount].balances[QUOTE], 150);
        assertEq(state.instruments[0].bids[10 * Q32].remainingQuantity, 85);

        vm.resumeGasMetering();
    }

    function test_CloseOrder_Cold() external {
        vm.pauseGasMetering();

        _setupInstrument();
        _initAccount(makerPk, makerAccount);
        _deposit(makerPk, makerAccount, 0, QUOTE, 10000);
        _placeLimitOrder(makerPk, makerAccount, 1, 50, 10 * Q32, 0);

        Mutation[] memory muts = new Mutation[](1);
        bytes[] memory data = new bytes[](1);
        Signature[] memory sigs = new Signature[](1);

        CloseOrder memory close = CloseOrder({orderId: 0, nonce: 2, deadline: type(uint256).max});
        muts[0] = Mutation.CloseOrder;
        data[0] = abi.encode(close);
        sigs[0] = Signature({
            account: makerAccount,
            keyId: 0,
            rawSignature: _sign(
                makerPk, keccak256(abi.encode(_CLOSE_ORDER_TYPEHASH, close.orderId, close.nonce, close.deadline))
            )
        });

        vm.resumeGasMetering();

        _exec(muts, data, sigs);

        vm.pauseGasMetering();

        assertEq(state.accounts[makerAccount].balances[QUOTE], 10000);
        assertEq(state.accounts[makerAccount].orders[0].quantity, 0);
        assertEq(state.instruments[0].bids[10 * Q32].quantity, 0);

        vm.resumeGasMetering();
    }

    function test_Withdrawal_Cold() external {
        vm.pauseGasMetering();

        _setupInstrument();
        _initAccount(makerPk, makerAccount);
        _deposit(makerPk, makerAccount, 0, QUOTE, 10000);

        Mutation[] memory muts = new Mutation[](1);
        bytes[] memory data = new bytes[](1);
        Signature[] memory sigs = new Signature[](1);

        Withdrawal memory w = Withdrawal({asset: QUOTE, amount: 3000, nonce: 1, deadline: type(uint256).max});
        muts[0] = Mutation.Withdrawal;
        data[0] = abi.encode(w);
        sigs[0] = Signature({
            account: makerAccount,
            keyId: 0,
            rawSignature: _sign(
                makerPk, keccak256(abi.encode(_WITHDRAWAL_TYPEHASH, w.asset, w.amount, w.nonce, w.deadline))
            )
        });

        vm.resumeGasMetering();

        _exec(muts, data, sigs);

        vm.pauseGasMetering();

        assertEq(state.accounts[makerAccount].balances[QUOTE], 7000);

        vm.resumeGasMetering();
    }

    function test_MakerSettlement() external {
        vm.pauseGasMetering();

        _setupInstrument();
        _initAccount(makerPk, makerAccount);
        _initAccount(takerPk, takerAccount);
        _deposit(makerPk, makerAccount, 0, QUOTE, 10000);
        _deposit(takerPk, takerAccount, 0, BASE, 10000);
        _placeLimitOrder(makerPk, makerAccount, 1, 100, 10 * Q32, 0);

        {
            Mutation[] memory m = new Mutation[](1);
            bytes[] memory d = new bytes[](1);
            Signature[] memory s = new Signature[](1);

            Fill[] memory fills = new Fill[](1);
            fills[0] = Fill({quantity: 40, price: 10 * Q32});

            MarketOrder memory mo = MarketOrder({
                quantity: 40,
                minReceivedQuantity: 0,
                instrumentId: 0,
                bidOrAsk: 1,
                nonce: 1,
                deadline: type(uint256).max
            });
            m[0] = Mutation.MarketOrder;
            d[0] = abi.encode(mo, MarketOrderResolution({fills: fills}));
            s[0] = Signature({
                account: takerAccount,
                keyId: 0,
                rawSignature: _sign(
                    takerPk,
                    keccak256(
                        abi.encode(
                            _MARKET_ORDER_TYPEHASH,
                            mo.quantity,
                            mo.minReceivedQuantity,
                            mo.instrumentId,
                            mo.bidOrAsk,
                            mo.nonce,
                            mo.deadline
                        )
                    )
                )
            });
            _exec(m, d, s);
        }

        assertEq(state.accounts[takerAccount].balances[BASE], 9960);
        assertEq(state.accounts[takerAccount].balances[QUOTE], 400);

        Mutation[] memory muts = new Mutation[](1);
        bytes[] memory data = new bytes[](1);
        Signature[] memory sigs = new Signature[](1);

        CloseOrder memory close = CloseOrder({orderId: 0, nonce: 2, deadline: type(uint256).max});
        muts[0] = Mutation.CloseOrder;
        data[0] = abi.encode(close);
        sigs[0] = Signature({
            account: makerAccount,
            keyId: 0,
            rawSignature: _sign(
                makerPk, keccak256(abi.encode(_CLOSE_ORDER_TYPEHASH, close.orderId, close.nonce, close.deadline))
            )
        });

        vm.resumeGasMetering();

        _exec(muts, data, sigs);

        vm.pauseGasMetering();

        assertEq(state.accounts[makerAccount].balances[QUOTE], 10000 - 1000 + 600);
        assertEq(state.accounts[makerAccount].balances[BASE], 40);

        vm.resumeGasMetering();
    }

    function test_MutationsOutOfOrder() external {
        Mutation[] memory muts = new Mutation[](2);
        bytes[] memory data = new bytes[](2);
        Signature[] memory sigs = new Signature[](2);

        muts[0] = Mutation.AddInstrument;
        data[0] = abi.encode(
            AddInstrumentParams({instrumentId: 0, base: BASE, quote: QUOTE, baseLotExp: 0, quoteLotExp: 0})
        );

        muts[1] = Mutation.Authorize;
        data[1] = new bytes(0);

        vm.prank(SCHEDULER);
        vm.expectRevert(MutationsOutOfOrder.selector);
        this.execute(ExecuteParams({mutations: muts, mutationData: data, signatures: sigs}));
    }

    function test_SignatureExpired() external {
        vm.pauseGasMetering();

        _setupInstrument();
        _initAccount(makerPk, makerAccount);

        Mutation[] memory muts = new Mutation[](1);
        bytes[] memory data = new bytes[](1);
        Signature[] memory sigs = new Signature[](1);

        Deposit memory d = Deposit({asset: QUOTE, amount: 100, nonce: 0, deadline: 0});
        muts[0] = Mutation.Deposit;
        data[0] = abi.encode(d);
        sigs[0] = Signature({
            account: makerAccount,
            keyId: 0,
            rawSignature: _sign(makerPk, keccak256(abi.encode(_DEPOSIT_TYPEHASH, d.asset, d.amount, d.nonce, d.deadline)))
        });

        vm.warp(1);

        vm.resumeGasMetering();

        vm.prank(SCHEDULER);
        vm.expectRevert(SignatureExpired.selector);
        this.execute(ExecuteParams({mutations: muts, mutationData: data, signatures: sigs}));
    }

    function test_InvalidNonce() external {
        vm.pauseGasMetering();

        _setupInstrument();
        _initAccount(makerPk, makerAccount);

        Mutation[] memory muts = new Mutation[](1);
        bytes[] memory data = new bytes[](1);
        Signature[] memory sigs = new Signature[](1);

        Deposit memory d = Deposit({asset: QUOTE, amount: 100, nonce: 99, deadline: type(uint256).max});
        muts[0] = Mutation.Deposit;
        data[0] = abi.encode(d);
        sigs[0] = Signature({
            account: makerAccount,
            keyId: 0,
            rawSignature: _sign(makerPk, keccak256(abi.encode(_DEPOSIT_TYPEHASH, d.asset, d.amount, d.nonce, d.deadline)))
        });

        vm.resumeGasMetering();

        vm.prank(SCHEDULER);
        vm.expectRevert(InvalidNonce.selector);
        this.execute(ExecuteParams({mutations: muts, mutationData: data, signatures: sigs}));
    }

    function test_KeyNotFound() external {
        vm.pauseGasMetering();

        _setupInstrument();
        _initAccount(makerPk, makerAccount);

        Mutation[] memory muts = new Mutation[](1);
        bytes[] memory data = new bytes[](1);
        Signature[] memory sigs = new Signature[](1);

        Deposit memory d = Deposit({asset: QUOTE, amount: 100, nonce: 0, deadline: type(uint256).max});
        muts[0] = Mutation.Deposit;
        data[0] = abi.encode(d);
        sigs[0] = Signature({
            account: makerAccount,
            keyId: 99,
            rawSignature: _sign(makerPk, keccak256(abi.encode(_DEPOSIT_TYPEHASH, d.asset, d.amount, d.nonce, d.deadline)))
        });

        vm.resumeGasMetering();

        vm.prank(SCHEDULER);
        vm.expectRevert();
        this.execute(ExecuteParams({mutations: muts, mutationData: data, signatures: sigs}));
    }
}
