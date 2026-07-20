// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IEligibilityGate} from "./interfaces/IEligibilityGate.sol";

/// @title OpenEligibilityGate — acceso permissionless e inmutable
/// @notice Implementación por defecto de NuvemFund mientras el protocolo opera sin KYC.
/// Cualquier wallet es elegible, no existe signer ni superficie de revocación, y un Fund que
/// guarda esta dirección como immutable no puede cambiar después a un gate restrictivo.
contract OpenEligibilityGate is IEligibilityGate {
    function isEligible(address) external pure returns (bool) {
        return true;
    }

    function ineligibleSince(address) external pure returns (uint48) {
        return 0;
    }
}
