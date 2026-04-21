// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";

import {Exchange, Bundle, Mutation, Signature, Unauthorized, LengthMismatch} from "src/Exchange.sol";

contract ExecuteTest is Test, Exchange(address(1)) {
    function test_Execute_Unauthorized() external {
        Bundle[] memory bundles = new Bundle[](1);
        bundles[0].mutations = new Mutation[](0);
        bundles[0].mutationData = new bytes[](0);
        bundles[0].signatures = new Signature[](0);

        vm.expectRevert(Unauthorized.selector);
        this.execute(bundles);
    }

    function test_Execute_LengthMismatch() external {
        Bundle[] memory bundles = new Bundle[](1);
        bundles[0].mutations = new Mutation[](1);
        bundles[0].mutationData = new bytes[](0);
        bundles[0].signatures = new Signature[](1);

        vm.prank(address(1));
        vm.expectRevert(LengthMismatch.selector);
        this.execute(bundles);
    }
}
