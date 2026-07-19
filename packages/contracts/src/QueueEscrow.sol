// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20} from "./interfaces/IERC20.sol";
import {SafeTransferLib} from "./libraries/SafeTransferLib.sol";

/// @title QueueEscrow — pot segregado del USDG de depósitos pendientes (SPEC §5.3, C11, D9)
/// @notice Contrato deliberadamente mínimo y SEPARADO del Fund: el dinero aún no invertido de los
/// usuarios vive aquí, fuera del address del Fund — un freeze/block del Fund por el emisor (o por
/// Paxos sobre el Fund) no alcanza este pot. Queda excluido del NAV por construcción (§5.1).
/// El Fund es el único autorizado a mover fondos: hacia sí mismo (ejecución de batch) o de vuelta
/// al usuario (cancelación/refund/anulación por Winding/Frozen).
contract QueueEscrow {
    using SafeTransferLib for IERC20;

    address public immutable FUND;
    IERC20 public immutable USDG;

    event Released(address indexed to, uint256 amount);

    error NotFund();
    error ZeroAddress();

    modifier onlyFund() {
        if (msg.sender != FUND) revert NotFund();
        _;
    }

    constructor(address fund_, IERC20 usdg_) {
        if (fund_ == address(0)) revert ZeroAddress();
        if (address(usdg_).code.length == 0) revert ZeroAddress();
        FUND = fund_;
        USDG = usdg_;
    }

    /// @notice Mueve USDG del escrow: al Fund (batch ejecutado) o al usuario (refund).
    /// La contabilidad de qué orden corresponde a qué importe vive en el Fund.
    function release(address to, uint256 amount) external onlyFund {
        USDG.safeTransfer(to, amount);
        emit Released(to, amount);
    }

    function balance() external view returns (uint256) {
        return USDG.balanceOf(address(this));
    }
}
