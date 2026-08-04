// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.20;

import {Script} from "forge-std/Script.sol";
import {PixelWar} from "../src/PixelWar.sol";

contract PixelWarScript is Script {
    function run() external {
        uint256 privateKey = vm.envUint("PRIVATE_KEY");
        address scheduler = vm.addr(privateKey);

        vm.startBroadcast();
        new PixelWar(scheduler);
        vm.stopBroadcast();
    }
}
