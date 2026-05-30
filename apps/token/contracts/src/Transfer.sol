// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Signature, State, verifyTokenSignature} from "./Token.sol";

library TransferMutation {
    struct Transfer {
        address from;
        address to;
        uint256 amount;
        uint256 nonce;
        uint256 deadline;
    }

    bytes32 constant TRANSFER_TYPEHASH =
        keccak256("Transfer(address from,address to,uint256 amount,uint256 nonce,uint256 deadline)");

    function hashTransfer(Transfer memory transfer) internal pure returns (bytes32) {
        return keccak256(
            abi.encode(
                TRANSFER_TYPEHASH, transfer.from, transfer.to, transfer.amount, transfer.nonce, transfer.deadline
            )
        );
    }

    function verifyTransferSignature(
        State storage state,
        Transfer memory transfer,
        Signature memory signature,
        bytes32 digest
    ) internal {
        verifyTokenSignature(state, signature, digest, transfer.from, transfer.nonce, transfer.deadline);
    }

    function executeTransfer(State storage state, Transfer memory transfer) internal {
        state.accounts[transfer.from].balance -= transfer.amount;
        unchecked {
            state.accounts[transfer.to].balance += transfer.amount;
        }
    }
}
