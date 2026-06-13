// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";

import {
    InvalidInstrument,
    InvalidMutation,
    SlippageExceeded,
    InsufficientBalance,
    Signature,
    State,
    insertBookTick
} from "src/Exchange.sol";
import {MarketOrderMutation} from "src/MarketOrder.sol";

contract MarketOrderTest is Test {
    State internal state;

    address constant BASE = address(1);
    address constant QUOTE = address(2);
    bytes32 constant ACCOUNT = bytes32(uint256(100));
    uint64 constant Q32 = 1 << 32;

    function setUp() public {
        state.instruments[0].base = BASE;
        state.instruments[0].quote = QUOTE;
        state.instruments[0].baseLotExp = 0;
        state.instruments[0].quoteLotExp = 0;

        state.accounts[ACCOUNT].balances[BASE] = 1000;
        state.accounts[ACCOUNT].balances[QUOTE] = 1000;

        _addAsk(10 * Q32, 100);
        _addBid(10 * Q32, 100);
    }

    function _addAsk(uint64 price, uint64 quantity) internal {
        state.instruments[0].asks[price].quantity = quantity;
        state.instruments[0].asks[price].remainingQuantity = quantity;
        insertBookTick(state.instruments[0], 1, price);
    }

    function _addBid(uint64 price, uint64 quantity) internal {
        state.instruments[0].bids[price].quantity = quantity;
        state.instruments[0].bids[price].remainingQuantity = quantity;
        insertBookTick(state.instruments[0], 0, price);
    }

    function _executeMarketOrder(MarketOrderMutation.MarketOrder memory order, bytes32 account) internal {
        MarketOrderMutation.executeMarketOrder(state, order, Signature({account: account, keyId: 0, rawSignature: ""}));
    }

    function callMarketOrder(MarketOrderMutation.MarketOrder memory order, bytes32 account) external {
        _executeMarketOrder(order, account);
    }

    function test_MarketOrder_InvalidInstrument() external {
        try this.callMarketOrder(
            MarketOrderMutation.MarketOrder({
                quantity: 1, minReceivedQuantity: 0, instrumentId: 99, bidOrAsk: 0, nonce: 0, deadline: 0
            }),
            ACCOUNT
        ) {
            fail();
        } catch (bytes memory reason) {
            assertEq(bytes4(reason), InvalidInstrument.selector);
        }
    }

    function test_MarketOrder_BuyFill() external {
        vm.pauseGasMetering();

        vm.resumeGasMetering();

        _executeMarketOrder(
            MarketOrderMutation.MarketOrder({
                quantity: 10, minReceivedQuantity: 0, instrumentId: 0, bidOrAsk: 0, nonce: 0, deadline: 0
            }),
            ACCOUNT
        );

        vm.pauseGasMetering();

        assertEq(state.accounts[ACCOUNT].balances[BASE], 1010);
        assertEq(state.accounts[ACCOUNT].balances[QUOTE], 900);

        assertEq(state.instruments[0].asks[10 * Q32].remainingQuantity, 90);

        vm.resumeGasMetering();
    }

    function test_MarketOrder_SellFill() external {
        vm.pauseGasMetering();

        vm.resumeGasMetering();

        _executeMarketOrder(
            MarketOrderMutation.MarketOrder({
                quantity: 10, minReceivedQuantity: 0, instrumentId: 0, bidOrAsk: 1, nonce: 0, deadline: 0
            }),
            ACCOUNT
        );

        vm.pauseGasMetering();

        assertEq(state.accounts[ACCOUNT].balances[BASE], 990);
        assertEq(state.accounts[ACCOUNT].balances[QUOTE], 1100);

        assertEq(state.instruments[0].bids[10 * Q32].remainingQuantity, 90);

        vm.resumeGasMetering();
    }

    function test_MarketOrder_MultipleFills() external {
        vm.pauseGasMetering();

        _addAsk(20 * Q32, 50);

        vm.resumeGasMetering();

        _executeMarketOrder(
            MarketOrderMutation.MarketOrder({
                quantity: 15, minReceivedQuantity: 0, instrumentId: 0, bidOrAsk: 0, nonce: 0, deadline: 0
            }),
            ACCOUNT
        );

        vm.pauseGasMetering();

        assertEq(state.accounts[ACCOUNT].balances[BASE], 1015);
        assertEq(state.accounts[ACCOUNT].balances[QUOTE], 850);

        vm.resumeGasMetering();
    }

    function test_MarketOrder_NotFullyFilled() external {
        try this.callMarketOrder(
            MarketOrderMutation.MarketOrder({
                quantity: 101, minReceivedQuantity: 0, instrumentId: 0, bidOrAsk: 0, nonce: 0, deadline: 0
            }),
            ACCOUNT
        ) {
            fail();
        } catch (bytes memory reason) {
            assertEq(bytes4(reason), InvalidMutation.selector);
        }
    }

    function test_MarketOrder_SlippageExceeded() external {
        try this.callMarketOrder(
            MarketOrderMutation.MarketOrder({
                quantity: 10, minReceivedQuantity: 999, instrumentId: 0, bidOrAsk: 0, nonce: 0, deadline: 0
            }),
            ACCOUNT
        ) {
            fail();
        } catch (bytes memory reason) {
            assertEq(bytes4(reason), SlippageExceeded.selector);
        }
    }

    function test_MarketOrder_InsufficientBalance() external {
        vm.pauseGasMetering();

        state.accounts[ACCOUNT].balances[QUOTE] = 0;

        vm.resumeGasMetering();

        try this.callMarketOrder(
            MarketOrderMutation.MarketOrder({
                quantity: 10, minReceivedQuantity: 0, instrumentId: 0, bidOrAsk: 0, nonce: 0, deadline: 0
            }),
            ACCOUNT
        ) {
            fail();
        } catch (bytes memory reason) {
            assertEq(bytes4(reason), InsufficientBalance.selector);
        }
    }

    function test_MarketOrder_BuyFillWithLotExp() external {
        vm.pauseGasMetering();

        state.instruments[0].baseLotExp = 18;
        state.instruments[0].quoteLotExp = 6;

        state.accounts[ACCOUNT].balances[BASE] = 0;
        state.accounts[ACCOUNT].balances[QUOTE] = 1000 << 6;

        vm.resumeGasMetering();

        _executeMarketOrder(
            MarketOrderMutation.MarketOrder({
                quantity: 10 << 18, minReceivedQuantity: 0, instrumentId: 0, bidOrAsk: 0, nonce: 0, deadline: 0
            }),
            ACCOUNT
        );

        vm.pauseGasMetering();

        assertEq(state.accounts[ACCOUNT].balances[BASE], 10 << 18);
        assertEq(state.accounts[ACCOUNT].balances[QUOTE], (1000 << 6) - (100 << 6));

        vm.resumeGasMetering();
    }
}
