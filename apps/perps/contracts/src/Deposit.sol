// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {InsufficientCollateral, State, requireAdmin} from "./Perps.sol";

/// Credits collateral that arrived outside the app. Mutations can't pull
/// tokens, so the admin attests each deposit.
library DepositMutation {
    struct Deposit {
        bytes32 account;
        uint256 amount;
    }

    function execute(State storage state, Deposit memory deposit, bytes32 accountID) internal {
        requireAdmin(state, accountID);
        if (deposit.amount == 0 || deposit.amount > uint256(type(int256).max)) revert InsufficientCollateral();
        state.accounts[deposit.account].collateral += int256(deposit.amount);
    }
}
