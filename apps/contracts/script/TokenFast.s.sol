// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Script, console} from "forge-std/Script.sol";
import {TokenFast} from "../src/TokenFast.sol";

contract TokenFastScript is Script {
    function run() external {
        address scheduler = vm.envAddress("SCHEDULER_ADDRESS");

        vm.startBroadcast();
        TokenFast token = new TokenFast(scheduler);
        vm.stopBroadcast();

        console.log("TokenFast deployed at:", address(token));
    }
}
