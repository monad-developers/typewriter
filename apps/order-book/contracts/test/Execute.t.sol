// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";

import {Exchange, Batch, Mutation, Signature, Unauthorized, LengthMismatch} from "src/Exchange.sol";

contract ExecuteTest is Test, Exchange(address(1)) {
    function test_Execute_Unauthorized() external {
        Batch[] memory batches = new Batch[](1);
        batches[0].mutations = new Mutation[](0);
        batches[0].mutationData = new bytes[](0);
        batches[0].signatures = new Signature[](0);

        vm.expectRevert(Unauthorized.selector);
        this.execute(batches, new uint256[](0));
    }

    function test_Execute_LengthMismatch() external {
        Batch[] memory batches = new Batch[](1);
        batches[0].mutations = new Mutation[](1);
        batches[0].mutationData = new bytes[](0);
        batches[0].signatures = new Signature[](1);

        vm.prank(address(1));
        vm.expectRevert(LengthMismatch.selector);
        this.execute(batches, new uint256[](0));
    }
}
