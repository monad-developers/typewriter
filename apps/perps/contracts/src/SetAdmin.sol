// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {InvalidAdmin, State, requireAdmin} from "./Perps.sol";

/// The first account to call this claims the empty admin seat for itself.
/// After that, only the admin can hand the seat to another account.
library SetAdminMutation {
    struct SetAdmin {
        bytes32 admin;
    }

    function execute(State storage state, SetAdmin memory setAdmin, bytes32 accountID) internal {
        if (setAdmin.admin == bytes32(0)) revert InvalidAdmin();
        if (state.admin == bytes32(0)) {
            if (setAdmin.admin != accountID) revert InvalidAdmin();
        } else {
            requireAdmin(state, accountID);
        }
        state.admin = setAdmin.admin;
    }
}
