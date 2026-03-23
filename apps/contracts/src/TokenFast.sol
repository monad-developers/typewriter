// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

struct TransferMutation {
    address from;
    address to;
    uint256 amount;
    uint256 nonce;
    uint256 deadline;
}

struct MintMutation {
    address to;
    uint256 amount;
}

enum Mutation {
    Transfer,
    Mint
}

struct Account {
    uint256 nonce;
    uint256 balance;
}

struct State {
    uint256 totalSupply;
    mapping(address => Account) accounts;
}

struct ExecuteParams {
    Mutation[] mutations;
    bytes[] mutationData;
    uint8[] v;
    bytes32[] r;
    bytes32[] s;
}

error Unauthorized();
error LengthMismatch();
error SignatureExpired();
error InvalidNonce();
error InvalidSignature();
error InvalidMutation();

contract TokenFast {
    State private state;
    address private immutable SCHEDULER;

    bytes32 private constant EIP712_DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");

    bytes32 private constant TRANSFER_TYPEHASH =
        keccak256("Transfer(address from,address to,uint256 amount,uint256 nonce,uint256 deadline)");

    uint256 private immutable INITIAL_CHAIN_ID;
    bytes32 private immutable INITIAL_DOMAIN_SEPARATOR;

    constructor(address _scheduler) {
        SCHEDULER = _scheduler;
        INITIAL_CHAIN_ID = block.chainid;
        INITIAL_DOMAIN_SEPARATOR = _computeDomainSeparator();
    }

    function DOMAIN_SEPARATOR() public view returns (bytes32) {
        return block.chainid == INITIAL_CHAIN_ID ? INITIAL_DOMAIN_SEPARATOR : _computeDomainSeparator();
    }

    function execute(ExecuteParams calldata params) external {
        if (msg.sender != SCHEDULER) {
            revert Unauthorized();
        }

        if (
            params.mutations.length != params.mutationData.length || params.mutations.length != params.v.length
                || params.mutations.length != params.r.length || params.mutations.length != params.s.length
        ) {
            revert LengthMismatch();
        }

        for (uint256 i = 0; i < params.mutations.length; i++) {
            Mutation mutation = params.mutations[i];
            bytes calldata data = params.mutationData[i];

            if (mutation == Mutation.Transfer) {
                TransferMutation memory transfer = abi.decode(data, (TransferMutation));

                if (transfer.deadline < block.timestamp) {
                    revert SignatureExpired();
                }

                if (transfer.nonce != state.accounts[transfer.from].nonce) {
                    revert InvalidNonce();
                }

                bytes32 structHash = keccak256(
                    abi.encode(
                        TRANSFER_TYPEHASH, transfer.from, transfer.to, transfer.amount, transfer.nonce, transfer.deadline
                    )
                );
                bytes32 digest = keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR(), structHash));

                address recovered = ecrecover(digest, params.v[i], params.r[i], params.s[i]);
                if (recovered == address(0) || recovered != transfer.from) {
                    revert InvalidSignature();
                }

                state.accounts[transfer.from].nonce++;
                state.accounts[transfer.from].balance -= transfer.amount;
                unchecked {
                    state.accounts[transfer.to].balance += transfer.amount;
                }
            } else if (mutation == Mutation.Mint) {
                MintMutation memory mint = abi.decode(data, (MintMutation));

                state.totalSupply += mint.amount;
                unchecked {
                    state.accounts[mint.to].balance += mint.amount;
                }
            } else {
                revert InvalidMutation();
            }
        }
    }

    function _computeDomainSeparator() private view returns (bytes32) {
        return keccak256(
            abi.encode(EIP712_DOMAIN_TYPEHASH, keccak256("FastTransfer"), keccak256("1"), block.chainid, address(this))
        );
    }
}
