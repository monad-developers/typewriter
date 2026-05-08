// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.20;

import {Script} from "forge-std/Script.sol";
import {Exchange} from "../src/Exchange.sol";

contract OrderBookScript is Script {
    function run() external {
        address scheduler = vm.envAddress("SCHEDULER_ADDRESS");

        vm.startBroadcast();
        new Exchange(scheduler);
        vm.stopBroadcast();
    }
}
