// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Typewriter, UnknownMutation} from "typewriter/Typewriter.sol";

struct State {
    mapping(bytes32 => uint256) balances;
}

library CreditMutation {
    struct Credit {
        uint256 amount;
    }

    function execute(State storage state, Credit memory credit, bytes32 accountID) internal {
        state.balances[accountID] += credit.amount;
    }
}

library DebitMutation {
    struct Debit {
        uint256 amount;
    }

    function execute(State storage state, Debit memory debit, bytes32 accountID) internal {
        state.balances[accountID] -= debit.amount;
    }
}

library AssertMutation {
    struct Assert {
        uint256 expected;
    }

    function execute(State storage state, Assert memory assertion, bytes32 accountID) internal view {
        require(state.balances[accountID] == assertion.expected, "assert failed");
    }
}

contract Harness is Typewriter {
    State internal state;

    enum Mutation {
        Credit,
        Debit,
        Assert
    }

    constructor() {
        SCHEDULER = msg.sender;
        FORCE_INCLUSION_DELAY = 658;
    }

    function dispatch(uint8 mutation, bytes memory mutationData, bytes32 accountID) internal override {
        if (mutation == uint8(Mutation.Credit)) {
            CreditMutation.Credit memory credit = abi.decode(mutationData, (CreditMutation.Credit));
            CreditMutation.execute(state, credit, accountID);
        } else if (mutation == uint8(Mutation.Debit)) {
            DebitMutation.Debit memory debit = abi.decode(mutationData, (DebitMutation.Debit));
            DebitMutation.execute(state, debit, accountID);
        } else if (mutation == uint8(Mutation.Assert)) {
            AssertMutation.Assert memory assertion = abi.decode(mutationData, (AssertMutation.Assert));
            AssertMutation.execute(state, assertion, accountID);
        } else {
            revert UnknownMutation(mutation);
        }
    }
}
