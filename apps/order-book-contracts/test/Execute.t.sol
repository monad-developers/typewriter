// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";

import {Exchange, ExecuteParams, Mutation, Signature, Unauthorized, LengthMismatch} from "src/Exchange.sol";

contract ExecuteTest is Test, Exchange(address(1)) {
    function test_Execute_Unauthorized() external {
        ExecuteParams memory params;
        params.mutations = new Mutation[](0);
        params.mutationData = new bytes[](0);
        params.signatures = new Signature[](0);

        vm.expectRevert(Unauthorized.selector);
        this.execute(params);
    }

    function test_Execute_LengthMismatch() external {
        ExecuteParams memory params;
        params.mutations = new Mutation[](1);
        params.mutationData = new bytes[](0);
        params.signatures = new Signature[](1);

        vm.prank(address(1));
        vm.expectRevert(LengthMismatch.selector);
        this.execute(params);
    }
}
