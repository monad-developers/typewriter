// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";

import {AccrueFundingMutation} from "src/AccrueFunding.sol";
import {AddMarketMutation} from "src/AddMarket.sol";
import {CancelOrderMutation} from "src/CancelOrder.sol";
import {DepositMutation} from "src/Deposit.sol";
import {LimitOrderMutation} from "src/LimitOrder.sol";
import {LiquidateMutation} from "src/Liquidate.sol";
import {health} from "src/Margin.sol";
import {MarketOrderMutation} from "src/MarketOrder.sol";
import {
    InsufficientLiquidity,
    InsufficientMargin,
    InvalidAdmin,
    MarketStatus,
    NotAdmin,
    NotLiquidatable,
    NotOrderOwner,
    ReduceOnly,
    Side,
    State,
    WouldCross
} from "src/Perps.sol";
import {SetAdminMutation} from "src/SetAdmin.sol";
import {SetOraclePricesMutation} from "src/SetOraclePrices.sol";
import {UpdateMarketMutation} from "src/UpdateMarket.sol";
import {WithdrawalMutation} from "src/Withdrawal.sol";

contract PerpsTest is Test {
    State internal state;

    bytes32 constant ADMIN = bytes32(uint256(1));
    bytes32 constant MAKER = bytes32(uint256(2));
    bytes32 constant TAKER = bytes32(uint256(3));
    uint64 constant MARKET = 7;
    uint64 constant PRICE = 1_000;

    function setUp() public {
        this.setAdmin(ADMIN, ADMIN);
        this.addMarket(
            AddMarketMutation.AddMarket({
                marketId: MARKET,
                tickSize: 10,
                oraclePrice: PRICE,
                initialMarginBps: 1_000,
                maintenanceMarginBps: 500,
                takerFeeBps: 10,
                liquidationFeeBps: 100
            })
        );
        this.deposit(MAKER, 1_000_000);
        this.deposit(TAKER, 1_000);
    }

    function setAdmin(bytes32 admin, bytes32 caller) external {
        SetAdminMutation.execute(state, SetAdminMutation.SetAdmin(admin), caller);
    }

    function addMarket(AddMarketMutation.AddMarket memory params) external {
        AddMarketMutation.execute(state, params, ADMIN);
    }

    function deposit(bytes32 account, uint256 amount) external {
        DepositMutation.execute(state, DepositMutation.Deposit(account, amount), ADMIN);
    }

    function limit(bytes32 account, Side side, uint64 price, uint64 quantity) external {
        LimitOrderMutation.execute(state, LimitOrderMutation.LimitOrder(MARKET, side, price, quantity), account);
    }

    function market(bytes32 account, Side side, uint64 quantity, uint64 limitPrice) external {
        MarketOrderMutation.execute(state, MarketOrderMutation.MarketOrder(MARKET, side, quantity, limitPrice), account);
    }

    function cancel(bytes32 account, uint64 orderId) external {
        CancelOrderMutation.execute(state, CancelOrderMutation.CancelOrder(orderId), account);
    }

    function withdraw(bytes32 account, uint256 amount) external {
        WithdrawalMutation.execute(state, WithdrawalMutation.Withdrawal(amount), account);
    }

    function setOracle(uint64 price) external {
        SetOraclePricesMutation.OraclePrice[] memory prices = new SetOraclePricesMutation.OraclePrice[](1);
        prices[0] = SetOraclePricesMutation.OraclePrice(MARKET, price);
        SetOraclePricesMutation.execute(state, SetOraclePricesMutation.SetOraclePrices(prices), ADMIN);
    }

    function accrue(int256 fundingPerLot) external {
        AccrueFundingMutation.Funding[] memory fundings = new AccrueFundingMutation.Funding[](1);
        fundings[0] = AccrueFundingMutation.Funding(MARKET, fundingPerLot);
        AccrueFundingMutation.execute(state, AccrueFundingMutation.AccrueFunding(fundings), ADMIN);
    }

    function updateMarket(MarketStatus status, uint16 initialMarginBps, uint16 maintenanceMarginBps) external {
        UpdateMarketMutation.execute(
            state,
            UpdateMarketMutation.UpdateMarket(MARKET, status, initialMarginBps, maintenanceMarginBps, 10, 100),
            ADMIN
        );
    }

    function liquidate(bytes32 account, uint64 quantity, uint64 limitPrice) external {
        LiquidateMutation.execute(state, LiquidateMutation.Liquidate(account, MARKET, quantity, limitPrice), ADMIN);
    }

    function equity(bytes32 account) internal view returns (int256 value) {
        (value,,) = health(state, account);
    }

    function totalValue() internal view returns (int256) {
        return equity(MAKER) + equity(TAKER) + state.insuranceFund;
    }

    function test_SetAdmin_ClaimOnlyForSelf() external {
        State storage fresh = state;
        fresh.admin = bytes32(0);
        vm.expectRevert(InvalidAdmin.selector);
        this.setAdmin(MAKER, TAKER);
        this.setAdmin(MAKER, MAKER);
        vm.expectRevert(NotAdmin.selector);
        this.setAdmin(TAKER, TAKER);
    }

    function depositAs(bytes32 caller) external {
        DepositMutation.execute(state, DepositMutation.Deposit(caller, 1), caller);
    }

    function test_AdminOnly() external {
        vm.expectRevert(NotAdmin.selector);
        this.depositAs(TAKER);
    }

    function test_LimitOrder_PostOnly() external {
        this.limit(MAKER, Side.Sell, 1_010, 5);
        vm.expectRevert(WouldCross.selector);
        this.limit(TAKER, Side.Buy, 1_010, 1);
    }

    function test_MarketOrder_FillsPriceTimePriority() external {
        this.limit(MAKER, Side.Sell, 1_010, 2);
        this.limit(MAKER, Side.Sell, 1_000, 2);
        this.market(TAKER, Side.Buy, 3, 1_010);

        assertEq(state.accounts[TAKER].positions[MARKET].size, 3);
        assertEq(state.accounts[TAKER].positions[MARKET].cost, 2 * 1_000 + 1 * 1_010);
        assertEq(state.accounts[MAKER].positions[MARKET].size, -3);
        assertEq(state.accounts[MAKER].positions[MARKET].askLots, 1);
        assertEq(state.markets[MARKET].bestAsk, 1_010);
        assertEq(state.markets[MARKET].openInterest, 3);
        // Taker fee: 3010 * 10bps = 3.
        assertEq(state.accounts[TAKER].collateral, 997);
        assertEq(state.insuranceFund, 3);
    }

    function test_MarketOrder_FillOrKill() external {
        this.limit(MAKER, Side.Sell, 1_000, 1);
        vm.expectRevert(InsufficientLiquidity.selector);
        this.market(TAKER, Side.Buy, 2, 2_000);
    }

    function test_MarketOrder_RequiresInitialMargin() external {
        this.limit(MAKER, Side.Sell, 1_000, 20);
        // 10 lots at 1000 needs 1000 at 10% IM, plus a 10 fee.
        vm.expectRevert(InsufficientMargin.selector);
        this.market(TAKER, Side.Buy, 10, 1_000);
        this.market(TAKER, Side.Buy, 9, 1_000);
    }

    function test_RealizedPnlAndConservation() external {
        int256 before = totalValue();
        this.limit(MAKER, Side.Sell, 1_000, 5);
        this.market(TAKER, Side.Buy, 5, 1_000);
        this.limit(MAKER, Side.Buy, 1_100, 3);
        this.setOracle(1_100);
        this.market(TAKER, Side.Sell, 3, 1_100);

        assertEq(state.accounts[TAKER].positions[MARKET].size, 2);
        assertEq(state.accounts[TAKER].positions[MARKET].cost, 2_000);
        // +300 realized, minus fees of 5 and 3.
        assertEq(state.accounts[TAKER].collateral, 1_000 + 300 - 5 - 3);
        assertEq(totalValue(), before);
    }

    function test_Funding_LongsPayShorts() external {
        this.limit(MAKER, Side.Sell, 1_000, 5);
        this.market(TAKER, Side.Buy, 5, 1_000);
        int256 takerBefore = equity(TAKER);
        int256 makerBefore = equity(MAKER);
        this.accrue(2);
        assertEq(equity(TAKER), takerBefore - 10);
        assertEq(equity(MAKER), makerBefore + 10);

        this.limit(MAKER, Side.Buy, 990, 5);
        this.market(TAKER, Side.Sell, 5, 990);
        assertEq(state.accounts[TAKER].positions[MARKET].size, 0);
        assertEq(state.accounts[TAKER].marketIds.length, 0);
    }

    function test_Withdrawal_KeepsInitialMargin() external {
        this.limit(MAKER, Side.Sell, 1_000, 5);
        this.market(TAKER, Side.Buy, 5, 1_000);
        // Equity 995, IM 500.
        vm.expectRevert(InsufficientMargin.selector);
        this.withdraw(TAKER, 496);
        this.withdraw(TAKER, 495);
    }

    function test_CancelOrder_OwnerOnly() external {
        this.limit(MAKER, Side.Sell, 1_000, 5);
        vm.expectRevert(NotOrderOwner.selector);
        this.cancel(TAKER, 1);
        this.cancel(MAKER, 1);
        assertEq(state.markets[MARKET].bestAsk, 0);
        assertEq(state.accounts[MAKER].marketIds.length, 0);
    }

    function test_SelfTradeCancelsRestingOrder() external {
        this.limit(TAKER, Side.Sell, 1_000, 1);
        this.limit(MAKER, Side.Sell, 1_010, 1);
        this.market(TAKER, Side.Buy, 1, 1_010);
        assertEq(state.orders[1].quantity, 0);
        assertEq(state.accounts[TAKER].positions[MARKET].size, 1);
        assertEq(state.accounts[TAKER].positions[MARKET].askLots, 0);
    }

    function test_ReduceOnly() external {
        this.limit(MAKER, Side.Sell, 1_000, 5);
        this.market(TAKER, Side.Buy, 2, 1_000);
        this.updateMarket(MarketStatus.ReduceOnly, 1_000, 500);
        vm.expectRevert(ReduceOnly.selector);
        this.market(TAKER, Side.Buy, 1, 1_000);
        this.limit(MAKER, Side.Buy, 990, 5);
        this.market(TAKER, Side.Sell, 1, 990);
    }

    function test_Liquidate() external {
        this.limit(MAKER, Side.Sell, 1_000, 9);
        this.market(TAKER, Side.Buy, 9, 1_000);
        this.limit(MAKER, Side.Buy, 950, 9);

        vm.expectRevert(NotLiquidatable.selector);
        this.liquidate(TAKER, 9, 900);

        // Equity 991 - 810 = 181 is below maintenance 9 * 910 * 5% = 409.
        this.setOracle(910);
        int256 before = totalValue();
        this.liquidate(TAKER, 9, 900);
        assertEq(state.accounts[TAKER].positions[MARKET].size, 0);
        // Realized -450 at 950, liquidation fee 85.
        assertEq(state.accounts[TAKER].collateral, 991 - 450 - 85);
        assertEq(totalValue(), before);
    }

    function test_Liquidate_InsuranceAbsorbsBadDebt() external {
        this.limit(MAKER, Side.Sell, 1_000, 9);
        this.market(TAKER, Side.Buy, 9, 1_000);
        this.limit(MAKER, Side.Buy, 800, 9);
        this.setOracle(800);
        int256 insuranceBefore = state.insuranceFund;
        this.liquidate(TAKER, 9, 800);
        // Realized -1800 and a 72 fee against 991 leaves -881 for insurance.
        assertEq(state.accounts[TAKER].collateral, 0);
        assertEq(state.insuranceFund, insuranceBefore + 72 - 881);
    }

    function test_Liquidate_CancelsRestingOrders() external {
        this.limit(MAKER, Side.Sell, 1_000, 9);
        this.market(TAKER, Side.Buy, 9, 1_000);
        this.setOracle(1_000);
        this.limit(TAKER, Side.Sell, 1_200, 1);
        this.limit(MAKER, Side.Buy, 900, 9);
        this.setOracle(905);
        this.liquidate(TAKER, 4, 900);
        assertEq(state.accounts[TAKER].positions[MARKET].size, 5);
        assertEq(state.accounts[TAKER].positions[MARKET].askLots, 0);
        assertEq(state.markets[MARKET].bestAsk, 0);
    }
}
