// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @notice Interfaz de acceso consumida por Fund. El despliegue permissionless usa
/// OpenEligibilityGate; EligibilityGate queda disponible solo como módulo legado opcional.
interface IEligibilityGate {
    /// @notice Si la wallet puede abrir o ampliar una posición y si el manager puede operar.
    function isEligible(address account) external view returns (bool);

    /// @notice Timestamp desde el que la cuenta es inelegible; 0 si es elegible.
    /// OpenEligibilityGate devuelve siempre 0, por lo que forceRedeem queda desactivado.
    function ineligibleSince(address account) external view returns (uint48);
}
