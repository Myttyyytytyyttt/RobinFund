// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20} from "./interfaces/IERC20.sol";
import {SafeTransferLib} from "./libraries/SafeTransferLib.sol";

/// @title StakeEscrow — stake first-loss del manager (SPEC §6, §4)
/// @notice Custodia el stake en USDG. Reparto de responsabilidades:
///  · El manager puede AÑADIR stake cuando quiera y solicitar/cancelar una reducción (aquí vive
///    el timelock `STAKE_WITHDRAW_TIMELOCK`).
///  · SOLO el Fund mueve dinero hacia fuera: `slash` (funding del first-loss hacia la
///    CompensationReserve, en settlement), `executeWithdraw` (la reducción solicitada, que el
///    Fund solo invoca en settlement y tras comprobar `aumCap` resultante ≥ AUM, §6), y
///    `releaseAll` (cierre del fondo, §4 Closed).
///  · Mientras una reducción está pendiente sin ejecutar, su importe SIGUE siendo slashable —
///    el timelock no protege al manager del first-loss (anti rug, §14.13).
contract StakeEscrow {
    using SafeTransferLib for IERC20;

    address public immutable FUND;
    IERC20 public immutable USDG;
    address public immutable MANAGER;
    uint48 public immutable WITHDRAW_TIMELOCK;

    uint256 public pendingWithdraw; // importe solicitado (6 dec USDG)
    uint48 public withdrawExecutableAt; // 0 = sin solicitud

    event StakeAdded(address indexed from, uint256 amount);
    event WithdrawRequested(uint256 amount, uint48 executableAt);
    event WithdrawCancelled();
    event WithdrawExecuted(uint256 amount);
    event Slashed(uint256 amount, address indexed to);
    event Released(uint256 amount);

    error NotFund();
    error NotManager();
    error NothingPending();
    error TimelockActive(uint48 executableAt);
    error InsufficientStake();

    modifier onlyFund() {
        if (msg.sender != FUND) revert NotFund();
        _;
    }

    constructor(address fund_, IERC20 usdg_, address manager_, uint48 withdrawTimelock_) {
        FUND = fund_;
        USDG = usdg_;
        MANAGER = manager_;
        WITHDRAW_TIMELOCK = withdrawTimelock_;
    }

    /// @notice Stake disponible para first-loss y para el cálculo de `aumCap` (incluye lo pendiente
    /// de reducción no ejecutada — sigue en riesgo hasta ejecutarse).
    function stakeAvailable() public view returns (uint256) {
        return USDG.balanceOf(address(this));
    }

    // --- Manager ---

    /// @notice Cualquiera puede añadir stake (normalmente el manager; un top-up de terceros solo
    /// beneficia a los LPs). Sube `aumCap` vía el Fund.
    function addStake(uint256 amount) external {
        USDG.safeTransferFrom(msg.sender, address(this), amount);
        emit StakeAdded(msg.sender, amount);
    }

    /// @notice Solicita reducir el stake. Re-solicitar reinicia el timelock (anti-griefing trivial:
    /// solo el manager puede hacerlo y solo se perjudica a sí mismo).
    function requestWithdraw(uint256 amount) external {
        if (msg.sender != MANAGER) revert NotManager();
        if (amount == 0 || amount > stakeAvailable()) revert InsufficientStake();
        pendingWithdraw = amount;
        withdrawExecutableAt = uint48(block.timestamp) + WITHDRAW_TIMELOCK;
        emit WithdrawRequested(amount, withdrawExecutableAt);
    }

    function cancelWithdraw() external {
        if (msg.sender != MANAGER) revert NotManager();
        if (withdrawExecutableAt == 0) revert NothingPending();
        pendingWithdraw = 0;
        withdrawExecutableAt = 0;
        emit WithdrawCancelled();
    }

    // --- Fund ---

    /// @notice Funding del first-loss (settlement, §6). El Fund calcula el importe
    /// (`min(stakeAvailable, neto agregado)`) y lo dirige a la CompensationReserve.
    function slash(uint256 amount, address to) external onlyFund {
        if (amount > stakeAvailable()) revert InsufficientStake();
        USDG.safeTransfer(to, amount);
        emit Slashed(amount, to);
    }

    /// @notice Ejecuta la reducción solicitada. El Fund la invoca SOLO en settlement y tras
    /// verificar la condición de cap (§6); aquí se verifica el timelock.
    function executeWithdraw() external onlyFund returns (uint256 amount) {
        if (withdrawExecutableAt == 0) revert NothingPending();
        if (block.timestamp < withdrawExecutableAt) revert TimelockActive(withdrawExecutableAt);
        amount = pendingWithdraw;
        if (amount > stakeAvailable()) amount = stakeAvailable(); // un slash intermedio pudo reducirlo
        pendingWithdraw = 0;
        withdrawExecutableAt = 0;
        USDG.safeTransfer(MANAGER, amount);
        emit WithdrawExecuted(amount);
    }

    /// @notice Liberación total al cierre (§4 Closed, tras `STAKE_RELEASE_GRACE` — condiciones en el Fund).
    function releaseAll() external onlyFund returns (uint256 amount) {
        amount = stakeAvailable();
        pendingWithdraw = 0;
        withdrawExecutableAt = 0;
        USDG.safeTransfer(MANAGER, amount);
        emit Released(amount);
    }
}
