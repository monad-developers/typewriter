// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {FFCA, EIP712_DOMAIN_TYPEHASH, UnknownMutation} from "ffca/FFCA.sol";

struct Inner {
    uint256 a;
    uint256 b;
}

struct State {
    uint256 total;
}

struct Signature {
    bytes32 accountId;
    bytes rawSignature;
}

library UpdateMutation {
    struct Update {
        Inner inner;
        uint256 nonce;
    }

    function executeUpdate(State storage state, Update memory update) internal {
        state.total += update.inner.a + update.inner.b;
    }
}

/// Fixture whose single mutation decodes a struct that itself contains a nested
/// struct member (`Inner`). Exercises the parser's handling of non-elementary
/// mutation params.
contract NestedParam is FFCA {
    State internal state;

    enum Mutation {
        Update
    }

    constructor() {
        SCHEDULER = msg.sender;
        FORCE_INCLUSION_DELAY = 658;
    }

    function dispatch(uint8 mutation, bytes memory mutationData, bytes memory) internal override {
        if (Mutation(mutation) == Mutation.Update) {
            UpdateMutation.Update memory update = abi.decode(mutationData, (UpdateMutation.Update));
            UpdateMutation.executeUpdate(state, update);
        } else {
            revert UnknownMutation(mutation);
        }
    }
}
