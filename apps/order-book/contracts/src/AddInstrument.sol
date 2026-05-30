// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {
    Instrument,
    InstrumentAlreadyExists,
    LotExpTooLarge,
    PERM_ADD_INSTRUMENT,
    Signature,
    State,
    Unauthorized,
    verifyMutationSignature
} from "./Exchange.sol";

library AddInstrumentMutation {
    struct AddInstrument {
        uint64 instrumentId;
        address base;
        address quote;
        uint8 baseLotExp;
        uint8 quoteLotExp;
        uint256 nonce;
        uint256 deadline;
    }

    bytes32 constant ADD_INSTRUMENT_TYPEHASH = keccak256(
        "AddInstrument(uint64 instrumentId,address base,address quote,uint8 baseLotExp,uint8 quoteLotExp,uint256 nonce,uint256 deadline)"
    );

    function hashAddInstrument(AddInstrument memory instrument) internal pure returns (bytes32) {
        return keccak256(
            abi.encode(
                ADD_INSTRUMENT_TYPEHASH,
                instrument.instrumentId,
                instrument.base,
                instrument.quote,
                instrument.baseLotExp,
                instrument.quoteLotExp,
                instrument.nonce,
                instrument.deadline
            )
        );
    }

    function verifyAddInstrumentSignature(
        State storage state,
        AddInstrument memory instrument,
        Signature memory signature,
        bytes32 digest
    ) internal {
        uint16 permissions = verifyMutationSignature(state, signature, digest, instrument.nonce, instrument.deadline);
        if ((permissions & PERM_ADD_INSTRUMENT) == 0) revert Unauthorized();
    }

    function executeAddInstrument(State storage state, AddInstrument memory instrument) internal {
        if (instrument.baseLotExp > 128 || instrument.quoteLotExp > 128) revert LotExpTooLarge();

        Instrument storage stored = state.instruments[instrument.instrumentId];
        if (stored.base != address(0)) revert InstrumentAlreadyExists();

        stored.base = instrument.base;
        stored.quote = instrument.quote;
        stored.baseLotExp = instrument.baseLotExp;
        stored.quoteLotExp = instrument.quoteLotExp;
    }
}
