// SPDX-License-Identifier: MIT
pragma solidity >=0.8.0;

import {ERC20} from "solmate/tokens/ERC20.sol";

contract TestToken is ERC20 {
    constructor(address initialHolder, uint256 initialSupply) ERC20("Test Token", "TEST", 18) {
        _mint(initialHolder, initialSupply);
    }
}
