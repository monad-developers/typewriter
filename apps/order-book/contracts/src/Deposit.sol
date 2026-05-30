// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {PERM_DEPOSIT, Signature, State, Unauthorized, verifyMutationSignature} from "./Exchange.sol";

library DepositMutation {
    struct Deposit {
        address asset;
        uint256 amount;
        uint256 nonce;
        uint256 deadline;
    }

    bytes32 constant DEPOSIT_TYPEHASH =
        keccak256("Deposit(address asset,uint256 amount,uint256 nonce,uint256 deadline)");

    function hashDeposit(Deposit memory deposit) internal pure returns (bytes32) {
        return keccak256(abi.encode(DEPOSIT_TYPEHASH, deposit.asset, deposit.amount, deposit.nonce, deposit.deadline));
    }

    function verifyDepositSignature(
        State storage state,
        Deposit memory deposit,
        Signature memory signature,
        bytes32 digest
    ) internal {
        uint16 permissions = verifyMutationSignature(state, signature, digest, deposit.nonce, deposit.deadline);
        if ((permissions & PERM_DEPOSIT) == 0) revert Unauthorized();
    }

    function executeDeposit(State storage state, Deposit memory deposit, Signature memory signature) internal {
        state.accounts[signature.account].balances[deposit.asset] += deposit.amount;
    }
}
