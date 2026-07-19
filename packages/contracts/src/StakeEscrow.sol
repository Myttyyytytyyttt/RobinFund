// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20} from "./interfaces/IERC20.sol";
import {SafeTransferLib} from "./libraries/SafeTransferLib.sol";

/// @title StakeEscrow — stake first-loss del manager (SPEC §6, §4; revisión 1.2 aplicada)
/// @notice Custodia el stake en USDG. Invariantes que ESTE contrato garantiza (no promesas al Fund):
///  · El slash solo puede ir a la CompensationReserve (inmutable) — nunca a otra parte (G5).
///  · La reducción exige timelock de 7d Y caduca a los 30d sin ejecutar (sin opción de salida
///    permanente; una solicitud vieja no vale como aviso, G3-A).
///  · Los slashes posteriores a la solicitud REDUCEN lo solicitado — stake añadido después de
///    la solicitud no puede salir por ella sin nuevo timelock (G3-B).
///  · La liberación total es two-step con RELEASE_GRACE (30d) en el propio escrow: los LPs ven
///    on-chain el aviso de cierre aunque la lógica de Closed del Fund tenga un bug (G1).
/// Siguen siendo obligaciones del Fund (documentadas en SPEC §6/§12): invocar executeWithdraw
/// solo en settlement, tras slash y tras comprobar aumCap resultante ≥ AUM.
contract StakeEscrow {
    using SafeTransferLib for IERC20;

    address public immutable FUND;
    IERC20 public immutable USDG;
    address public immutable MANAGER;
    address public immutable RESERVE; // única salida legítima del slash (G5)
    uint48 public immutable WITHDRAW_TIMELOCK;
    uint48 public constant EXECUTION_WINDOW = 30 days; // caducidad de la solicitud madurada (G3-A)
    uint48 public constant RELEASE_GRACE = 30 days; // STAKE_RELEASE_GRACE (§4, G1)

    uint256 public pendingWithdraw; // se reduce con cada slash posterior a la solicitud (G3-B)
    uint48 public withdrawExecutableAt; // 0 = sin solicitud
    uint48 public releaseStartedAt; // 0 = cierre no iniciado

    event StakeAdded(address indexed from, uint256 amount);
    event WithdrawRequested(uint256 amount, uint48 executableAt);
    event WithdrawCancelled();
    event WithdrawExecuted(uint256 amount);
    event Slashed(uint256 amount);
    event ReleaseStarted(uint48 executableAt);
    event Released(uint256 amount);

    error ZeroAddress();
    error NotFund();
    error NotManager();
    error NothingPending();
    error TimelockActive(uint48 executableAt);
    error RequestExpired();
    error InsufficientStake();
    error BadTimelock();
    error ReleaseNotStarted();
    error GraceActive(uint48 executableAt);

    modifier onlyFund() {
        if (msg.sender != FUND) revert NotFund();
        _;
    }

    constructor(address fund_, IERC20 usdg_, address manager_, address reserve_, uint48 withdrawTimelock_) {
        if (fund_ == address(0) || manager_ == address(0) || reserve_ == address(0)) revert ZeroAddress();
        if (address(usdg_).code.length == 0) revert ZeroAddress(); // G7/G11
        if (withdrawTimelock_ < 1 days) revert BadTimelock(); // G17: un factory mal configurado no anula el anti-rug
        FUND = fund_;
        USDG = usdg_;
        MANAGER = manager_;
        RESERVE = reserve_;
        WITHDRAW_TIMELOCK = withdrawTimelock_;
    }

    /// @notice Stake disponible para first-loss y `aumCap` (incluye lo pendiente de reducción:
    /// sigue en riesgo hasta ejecutarse, §14.13).
    function stakeAvailable() public view returns (uint256) {
        return USDG.balanceOf(address(this));
    }

    // --- Manager ---

    /// @notice Cualquiera puede añadir stake (un top-up de terceros solo beneficia a los LPs).
    function addStake(uint256 amount) external {
        USDG.safeTransferFrom(msg.sender, address(this), amount);
        emit StakeAdded(msg.sender, amount);
    }

    /// @notice Solicita reducir el stake. Re-solicitar reinicia el timelock.
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

    /// @notice Funding del first-loss (settlement, §6): SOLO hacia la CompensationReserve (G5).
    /// Reduce cualquier solicitud pendiente — el stake fresco no hereda el timelock viejo (G3-B).
    function slash(uint256 amount) external onlyFund {
        if (amount > stakeAvailable()) revert InsufficientStake();
        if (withdrawExecutableAt != 0) {
            pendingWithdraw = pendingWithdraw > amount ? pendingWithdraw - amount : 0;
        }
        USDG.safeTransfer(RESERVE, amount);
        emit Slashed(amount);
    }

    /// @notice Ejecuta la reducción. El Fund la invoca solo en settlement, tras slash y cap-check.
    /// Ventana de ejecución (G3-A): madurada pero no ejecutada en 30d ⇒ caduca (re-solicitar).
    function executeWithdraw() external onlyFund returns (uint256 amount) {
        uint48 executableAt = withdrawExecutableAt;
        if (executableAt == 0) revert NothingPending();
        if (block.timestamp < executableAt) revert TimelockActive(executableAt);
        if (block.timestamp > executableAt + EXECUTION_WINDOW) revert RequestExpired();
        amount = pendingWithdraw;
        if (amount > stakeAvailable()) amount = stakeAvailable();
        pendingWithdraw = 0;
        withdrawExecutableAt = 0;
        USDG.safeTransfer(MANAGER, amount);
        emit WithdrawExecuted(amount);
    }

    /// @notice Cierre two-step (G1): el Fund inicia en Closed; la liberación solo ejecuta tras
    /// RELEASE_GRACE — aviso on-chain de 30 días para LPs/keepers aunque el Fund tenga un bug.
    function startRelease() external onlyFund {
        releaseStartedAt = uint48(block.timestamp);
        emit ReleaseStarted(releaseStartedAt + RELEASE_GRACE);
    }

    function releaseAll() external onlyFund returns (uint256 amount) {
        if (releaseStartedAt == 0) revert ReleaseNotStarted();
        if (block.timestamp < releaseStartedAt + RELEASE_GRACE) {
            revert GraceActive(releaseStartedAt + RELEASE_GRACE);
        }
        amount = stakeAvailable();
        pendingWithdraw = 0;
        withdrawExecutableAt = 0;
        USDG.safeTransfer(MANAGER, amount);
        emit Released(amount);
    }
}
