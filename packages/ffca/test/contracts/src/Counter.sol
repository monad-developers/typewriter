// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

struct Bundle {
    uint8[] mutations;
    bytes[] mutationData;
    bytes[] signatures;
}

struct State {
    uint256 total;
}

/// Test fixture for ffca's submit path. Each `add` mutation contributes its
/// `amount` to a running total; ffca's local `apply` mirrors the same
/// addition so server-side state matches the chain.
contract Counter {
    State public state;

    uint8 constant ADD = 0;

    function execute(Bundle[] calldata bundles) external {
        for (uint256 b; b < bundles.length; b++) {
            Bundle calldata bundle = bundles[b];
            for (uint256 i; i < bundle.mutations.length; i++) {
                _apply(bundle.mutations[i], bundle.mutationData[i]);
            }
        }
    }

    function _apply(uint8 tag, bytes calldata data) internal {
        if (tag == ADD) {
            (uint256 amount) = abi.decode(data, (uint256));
            state.total += amount;
        } else {
            revert("unknown tag");
        }
    }
}
