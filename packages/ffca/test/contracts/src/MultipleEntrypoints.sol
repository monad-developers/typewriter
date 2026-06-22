// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {FFCA} from "ffca/FFCA.sol";

abstract contract FirstEntrypoint is FFCA {}

abstract contract SecondEntrypoint is FFCA {}
