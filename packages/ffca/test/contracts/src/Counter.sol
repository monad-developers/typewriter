// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

struct Bundle {
    uint8[] mutations;
    bytes[] mutationData;
    bytes[] signatures;
}

/// Test fixture for ffca's submit path. Counts bundles and mutations as they
/// land via execute(); ffca tests assert on these counters to verify the
/// bundle reached the contract with the expected shape.
contract Counter {
    uint256 public bundleCount;
    uint256 public mutationCount;

    function execute(Bundle[] calldata bundles) external {
        bundleCount += bundles.length;
        for (uint256 i; i < bundles.length; i++) {
            mutationCount += bundles[i].mutations.length;
        }
    }
}
