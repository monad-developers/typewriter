// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract PrecompileCaller {
    function callPrecompile(address target, bytes calldata data) external view returns (bytes memory) {
        (bool ok, bytes memory ret) = target.staticcall(data);
        require(ok);
        return ret;
    }
}
