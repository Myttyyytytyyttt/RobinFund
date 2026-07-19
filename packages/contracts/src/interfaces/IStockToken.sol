// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20} from "./IERC20.sol";

/// @notice Interfaz de los Stock Tokens de RHJ (contrato verificado "Stock" en chain 4663).
/// Nombres tomados del ABI verificado en Blockscout — no de la spec ERC-8056 draft.
interface IStockToken is IERC20 {
    // ERC-8056 (Scaled UI Amount)
    function uiMultiplier() external view returns (uint256);
    function newUIMultiplier() external view returns (uint256);
    function effectiveAt() external view returns (uint256);
    function balanceOfUI(address account) external view returns (uint256);
    function totalSupplyUI() external view returns (uint256);

    // Estados de pausa (verificados on-chain)
    function tokenPaused() external view returns (bool);
    function oraclePaused() external view returns (bool);
    function paused() external view returns (bool);

    // Puntero al registry de access controls (nombre exacto del ABI verificado)
    function ACCESS_CONTROLLED_REGISTRY() external view returns (address);
}

/// @notice Registry compartido de access controls de RHJ (default-allow blacklist).
interface IAccessControlledRegistry {
    function isBlocked(address account) external view returns (bool);
    function paused() external view returns (bool);
}
