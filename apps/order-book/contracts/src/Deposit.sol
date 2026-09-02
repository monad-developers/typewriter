// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {State} from "./OrderBook.sol";

library DepositMutation {
    struct Deposit {
        address asset;
        uint256 amount;
    }

    function executeDeposit(State storage state, Deposit memory deposit, bytes32 accountID) internal {
        state.accounts[accountID].balances[deposit.asset] += deposit.amount;
    }
}
