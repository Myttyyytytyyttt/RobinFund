// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @notice Gate de elegibilidad (SPEC §10). Implementación completa en Fase 1.5;
/// el Fund solo depende de esta interfaz.
interface IEligibilityGate {
    /// @notice Elegible ahora mismo (atestación vigente, no revocada).
    function isEligible(address account) external view returns (bool);

    /// @notice Timestamp desde el que la cuenta es inelegible (caducidad o revocación);
    /// 0 si es elegible. Usado por la redención forzosa (§10.2: gracia de 30 días).
    function ineligibleSince(address account) external view returns (uint48);
}
