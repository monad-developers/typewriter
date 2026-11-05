// SPDX-License-Identifier: MIT
pragma solidity ^0.8.21;

import {Typewriter, UnknownMutation} from "typewriter/Typewriter.sol";

struct State {
    /// A hash over every executed mutation, in execution order.
    bytes32 accumulator;
    mapping(uint256 => bytes32) slots;
}

error InvalidScheduler();
error AError();
error BError();
error CError();

/// A mutation reverts when `shouldRevert` is set, so a failure depends only on the input.
library AMutation {
    struct A {
        uint256 slot;
        uint256 value;
        bool shouldRevert;
    }

    function execute(State storage state, A memory a, bytes32 accountID) internal {
        if (a.shouldRevert) revert AError();
        state.slots[a.slot] = bytes32(a.value);
        state.accumulator = keccak256(abi.encode(state.accumulator, uint8(0), accountID, a.slot, a.value));
    }
}

library BMutation {
    struct B {
        uint256 slot;
        uint256 value;
        bool shouldRevert;
    }

    function execute(State storage state, B memory b, bytes32 accountID) internal {
        if (b.shouldRevert) revert BError();
        state.slots[b.slot] = keccak256(abi.encode(b.value));
        state.accumulator = keccak256(abi.encode(state.accumulator, uint8(1), accountID, b.slot, b.value));
    }
}

/// Writes `count` slots, so a large count outgrows a settlement.
library CMutation {
    struct C {
        uint256 count;
        bool shouldRevert;
    }

    function execute(State storage state, C memory c, bytes32 accountID) internal {
        if (c.shouldRevert) revert CError();
        for (uint256 i = 0; i < c.count; i++) {
            state.slots[type(uint128).max + i] = bytes32(i + 1);
        }
        state.accumulator = keccak256(abi.encode(state.accumulator, uint8(2), accountID, c.count));
    }
}

contract Assessment is Typewriter {
    State internal state;

    enum Mutation {
        A,
        B,
        C
    }

    constructor(address _scheduler) Typewriter(_scheduler) {
        if (_scheduler == address(0)) revert InvalidScheduler();
        FORCE_INCLUSION_DELAY = 365 days;
    }

    function dispatch(uint8 mutation, bytes memory mutationData, bytes32 accountID) internal override {
        if (mutation == uint8(Mutation.A)) {
            AMutation.execute(state, abi.decode(mutationData, (AMutation.A)), accountID);
        } else if (mutation == uint8(Mutation.B)) {
            BMutation.execute(state, abi.decode(mutationData, (BMutation.B)), accountID);
        } else if (mutation == uint8(Mutation.C)) {
            CMutation.execute(state, abi.decode(mutationData, (CMutation.C)), accountID);
        } else {
            revert UnknownMutation(mutation);
        }
    }
}
