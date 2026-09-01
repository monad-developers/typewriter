// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {State} from "./Token.sol";

library TransferMutation {
    struct Transfer {
        bytes32 to;
        uint256 amount;
    }

    function execute(State storage state, Transfer memory transfer, bytes32 accountID) internal {
        state.balances[accountID] -= transfer.amount;
        unchecked {
            state.balances[transfer.to] += transfer.amount;
        }
    }
}
