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
error DError();
error EError();

/// Writes a mutation that is only checked against the chain: its slot holds
/// the hash of its encoding, so the slot shows every field arrived.
function record(State storage state, uint8 mutation, bytes32 accountID, uint256 slot, bytes memory encoded) {
    state.slots[slot] = keccak256(encoded);
    state.accumulator = keccak256(abi.encode(state.accumulator, mutation, accountID, keccak256(encoded)));
}

/// Reverts when `shouldRevert` is set, so a failure depends only on the input.
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

/// Reverts when `shouldRevert` is set, so a failure depends only on the input.
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

/// Dynamic types.
library CMutation {
    struct C {
        uint256 slot;
        bytes data;
        string memo;
        bool shouldRevert;
    }

    function execute(State storage state, C memory c, bytes32 accountID) internal {
        if (c.shouldRevert) revert CError();
        record(state, 2, accountID, c.slot, abi.encode(c));
    }
}

/// Static types narrower than a word.
library DMutation {
    struct D {
        uint256 slot;
        address to;
        int64 delta;
        bytes32 tag;
        uint8 small;
        uint40 window;
        bool shouldRevert;
    }

    function execute(State storage state, D memory d, bytes32 accountID) internal {
        if (d.shouldRevert) revert DError();
        record(state, 3, accountID, d.slot, abi.encode(d));
    }
}

/// Arrays.
library EMutation {
    struct E {
        uint256 slot;
        uint256[] values;
        address[2] pair;
        bool shouldRevert;
    }

    function execute(State storage state, E memory e, bytes32 accountID) internal {
        if (e.shouldRevert) revert EError();
        record(state, 4, accountID, e.slot, abi.encode(e));
    }
}

contract Assessment is Typewriter {
    State internal state;

    enum Mutation {
        A,
        B,
        C,
        D,
        E
    }

    constructor(address _scheduler) Typewriter(_scheduler) {
        if (_scheduler == address(0)) revert InvalidScheduler();
        FORCE_INCLUSION_DELAY = 365 days;
    }

    function dispatch(uint8 mutation, bytes memory mutationData, bytes32 accountID) internal override {
        if (mutation == uint8(Mutation.A)) {
            AMutation.A memory a = abi.decode(mutationData, (AMutation.A));
            AMutation.execute(state, a, accountID);
        } else if (mutation == uint8(Mutation.B)) {
            BMutation.B memory b = abi.decode(mutationData, (BMutation.B));
            BMutation.execute(state, b, accountID);
        } else if (mutation == uint8(Mutation.C)) {
            CMutation.C memory c = abi.decode(mutationData, (CMutation.C));
            CMutation.execute(state, c, accountID);
        } else if (mutation == uint8(Mutation.D)) {
            DMutation.D memory d = abi.decode(mutationData, (DMutation.D));
            DMutation.execute(state, d, accountID);
        } else if (mutation == uint8(Mutation.E)) {
            EMutation.E memory e = abi.decode(mutationData, (EMutation.E));
            EMutation.execute(state, e, accountID);
        } else {
            revert UnknownMutation(mutation);
        }
    }
}
