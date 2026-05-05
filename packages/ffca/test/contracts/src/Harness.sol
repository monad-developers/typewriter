// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

struct Bundle {
    uint8[] mutations;
    bytes[] mutationData;
    bytes[] signatures;
}

struct State {
    mapping(address => uint256) balances;
}

/// Test fixture for ffca's submit path that exercises ordering and
/// resolution. Three mutation tags:
///
///   CREDIT (0): args = (account, amount), no resolution. Adds amount.
///   DEBIT  (1): args = (account, amount), resolution = (newBalance).
///                Reverts if resolution doesn't match the pre-state, so a
///                stale or dishonest resolver fails the bundle.
///   ASSERT (2): args = (account, expected). Read-only check — reverts if
///                balance != expected. Used as a deliberate ordering probe
///                in tests; it has no state effect, so ffca's local apply
///                is intentionally a no-op.
contract Harness {
    // Solidity disallows public getters on structs containing mappings, so
    // `state` is internal here and `balances(address)` is hand-written.
    State internal state;

    uint8 constant CREDIT = 0;
    uint8 constant DEBIT = 1;
    uint8 constant ASSERT = 2;

    function balances(address account) external view returns (uint256) {
        return state.balances[account];
    }

    function execute(Bundle[] calldata bundles) external {
        for (uint256 b; b < bundles.length; b++) {
            Bundle calldata bundle = bundles[b];
            for (uint256 i; i < bundle.mutations.length; i++) {
                _apply(bundle.mutations[i], bundle.mutationData[i]);
            }
        }
    }

    function _apply(uint8 tag, bytes calldata data) internal {
        if (tag == CREDIT) {
            (address account, uint256 amount) = abi.decode(
                data,
                (address, uint256)
            );
            state.balances[account] += amount;
        } else if (tag == DEBIT) {
            (address account, uint256 amount, uint256 newBalance) = abi
                .decode(data, (address, uint256, uint256));
            require(
                state.balances[account] == newBalance + amount,
                "debit: stale resolution"
            );
            state.balances[account] = newBalance;
        } else if (tag == ASSERT) {
            (address account, uint256 expected) = abi.decode(
                data,
                (address, uint256)
            );
            require(state.balances[account] == expected, "assert failed");
        } else {
            revert("unknown tag");
        }
    }
}
