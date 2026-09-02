// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Instrument, InstrumentAlreadyExists, LotExpTooLarge, State} from "./OrderBook.sol";

library AddInstrumentMutation {
    struct AddInstrument {
        uint64 instrumentId;
        address base;
        address quote;
        uint8 baseLotExp;
        uint8 quoteLotExp;
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
