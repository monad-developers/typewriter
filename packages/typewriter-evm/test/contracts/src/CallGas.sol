// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract CallGasCallee {
    function burn(uint256 count) external pure returns (uint256) {
        uint256 total;
        for (uint256 i; i < count; i++) {
            total += i;
        }
        return total;
    }
}

contract CallGasCaller {
    function callBurn(address target, uint256 count) external view returns (uint256) {
        return CallGasCallee(target).burn(count);
    }
}
