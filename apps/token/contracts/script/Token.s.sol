// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Script, console} from "forge-std/Script.sol";
import {Token} from "../src/Token.sol";

contract TokenScript is Script {
    function run() external {
        uint256 privateKey = vm.envUint("PRIVATE_KEY");
        address scheduler = vm.addr(privateKey);

        vm.startBroadcast(privateKey);
        Token token = new Token(scheduler);
        vm.stopBroadcast();

        console.log("Token deployed at:", address(token));
    }
}
