// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Signature, State, verifyTokenSignature} from "./Token.sol";

library MintMutation {
    struct Mint {
        address to;
        uint256 amount;
        uint256 nonce;
        uint256 deadline;
    }

    bytes32 constant MINT_TYPEHASH = keccak256("Mint(address to,uint256 amount,uint256 nonce,uint256 deadline)");

    function hashMint(Mint memory mint) internal pure returns (bytes32) {
        return keccak256(abi.encode(MINT_TYPEHASH, mint.to, mint.amount, mint.nonce, mint.deadline));
    }

    function verifyMintSignature(State storage state, Mint memory mint, Signature memory signature, bytes32 digest)
        internal
    {
        verifyTokenSignature(state, signature, digest, mint.to, mint.nonce, mint.deadline);
    }

    function executeMint(State storage state, Mint memory mint) internal {
        state.totalSupply += mint.amount;
        unchecked {
            state.accounts[mint.to].balance += mint.amount;
        }
    }
}
