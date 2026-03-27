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

struct QueuedTransfer {
    TransferMutation transfer;
    uint8 v;
    bytes32 r;
    bytes32 s;
    uint256 enqueuedBlock;
}

error Unauthorized();
error LengthMismatch();
error SignatureExpired();
error InvalidNonce();
error InvalidSignature();
error InvalidMutation();
error TooEarly();
error AlreadyExecuted();

event Enqueued(
    uint256 indexed index, address indexed from, address to, uint256 amount, uint256 nonce, uint256 deadline
);
event ForceExecuted(uint256 indexed index);

contract TokenFast {
    State private state;
    address private immutable SCHEDULER;

    QueuedTransfer[] private queue;

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

                _verifySignature(transfer, params.v[i], params.r[i], params.s[i]);

                state.accounts[transfer.from].nonce++;

                _executeTransfer(transfer);
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

    function enqueue(TransferMutation calldata transfer, uint8 v, bytes32 r, bytes32 s) external {
        if (transfer.deadline < block.timestamp) {
            revert SignatureExpired();
        }

        if (transfer.nonce != state.accounts[transfer.from].nonce) {
            revert InvalidNonce();
        }

        _verifySignature(transfer, v, r, s);

        state.accounts[transfer.from].nonce++;

        uint256 index = queue.length;
        queue.push(QueuedTransfer({transfer: transfer, v: v, r: r, s: s, enqueuedBlock: block.number}));

        emit Enqueued(index, transfer.from, transfer.to, transfer.amount, transfer.nonce, transfer.deadline);
    }

    function forceExecute(uint256 index) external {
        QueuedTransfer storage queued = queue[index];

        if (queued.enqueuedBlock == 0) {
            revert AlreadyExecuted();
        }

        if (block.number < queued.enqueuedBlock + 2) {
            revert TooEarly();
        }

        TransferMutation memory transfer = queued.transfer;

        delete queue[index];

        _executeTransfer(transfer);

        emit ForceExecuted(index);
    }

    function _executeTransfer(TransferMutation memory transfer) internal {
        state.accounts[transfer.from].balance -= transfer.amount;
        unchecked {
            state.accounts[transfer.to].balance += transfer.amount;
        }
    }

    function _verifySignature(TransferMutation memory transfer, uint8 v, bytes32 r, bytes32 s) internal view {
        bytes32 structHash = keccak256(
            abi.encode(
                TRANSFER_TYPEHASH, transfer.from, transfer.to, transfer.amount, transfer.nonce, transfer.deadline
            )
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR(), structHash));

        address recovered = ecrecover(digest, v, r, s);
        if (recovered == address(0) || recovered != transfer.from) {
            revert InvalidSignature();
        }
    }

    function _computeDomainSeparator() private view returns (bytes32) {
        return keccak256(
            abi.encode(EIP712_DOMAIN_TYPEHASH, keccak256("FastTransfer"), keccak256("1"), block.chainid, address(this))
        );
    }
}
