// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {
    InsufficientBalance,
    PERM_WITHDRAW,
    Signature,
    State,
    Unauthorized,
    verifyMutationSignature
} from "./Exchange.sol";

library WithdrawalMutation {
    struct Withdrawal {
        address asset;
        uint256 amount;
        uint256 nonce;
        uint256 deadline;
    }

    bytes32 constant WITHDRAWAL_TYPEHASH =
        keccak256("Withdrawal(address asset,uint256 amount,uint256 nonce,uint256 deadline)");

    function hashWithdrawal(Withdrawal memory withdrawal) internal pure returns (bytes32) {
        return keccak256(
            abi.encode(WITHDRAWAL_TYPEHASH, withdrawal.asset, withdrawal.amount, withdrawal.nonce, withdrawal.deadline)
        );
    }

    function verifyWithdrawalSignature(
        State storage state,
        Withdrawal memory withdrawal,
        Signature memory signature,
        bytes32 digest
    ) internal {
        uint16 permissions = verifyMutationSignature(state, signature, digest, withdrawal.nonce, withdrawal.deadline);
        if ((permissions & PERM_WITHDRAW) == 0) revert Unauthorized();
    }

    function executeWithdrawal(State storage state, Withdrawal memory withdrawal, Signature memory signature) internal {
        if (state.accounts[signature.account].balances[withdrawal.asset] < withdrawal.amount) {
            revert InsufficientBalance();
        }
        unchecked {
            state.accounts[signature.account].balances[withdrawal.asset] -= withdrawal.amount;
        }
    }
}
