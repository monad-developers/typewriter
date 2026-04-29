// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Script, console} from "forge-std/Script.sol";
import {Token} from "../src/Token.sol";

contract TokenScript is Script {
    function run() external {
        string memory name = "Hi Kevin";
        string memory symbol = "HK";
        uint8 decimals = 18;

        vm.startBroadcast();
        Token token = new Token(name, symbol, decimals);
        vm.stopBroadcast();

        console.log("Token deployed at:", address(token));
    }
}
