// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20} from "./interfaces/IERC20.sol";
import {SafeTransferLib} from "./libraries/SafeTransferLib.sol";

/// @title CompensationReserve — funding y claims pull del first-loss, por período (SPEC §6)
/// @notice Contrato separado del Fund (§10.3: los claims ya adjudicados siguen pagándose aunque
/// el Fund quede Frozen). Contabilidad mecánica: el Fund decide CUÁNTO se fondea (funding neteado
/// exacto on-chain) y CUÁNTO cobra cada LP (claims con λ, materialización perezosa); este contrato
/// hace cumplir los invariantes de caja:
///  · `Σ pagado(período) ≤ fondeado(período)` — "Σ claims ≤ funding forzado por contrato" (§6)
///  · el rollover (v0.7) solo mueve el no-pagado, y NUNCA hacia el manager
///  · la caja total cubre siempre lo fondeado no pagado
contract CompensationReserve {
    using SafeTransferLib for IERC20;

    address public immutable FUND;
    IERC20 public immutable USDG;

    mapping(uint64 => uint256) public funded; // por período (6 dec USDG)
    mapping(uint64 => uint256) public paid;
    uint256 public totalFunded;
    uint256 public totalPaid;

    event PeriodFunded(uint64 indexed period, uint256 amount);
    event ClaimPaid(uint64 indexed period, address indexed lp, uint256 amount);
    event RolledOver(uint64 indexed fromPeriod, uint64 indexed toPeriod, uint256 amount);

    error NotFund();
    error ExceedsFunding();
    error UnderCollateralized();

    modifier onlyFund() {
        if (msg.sender != FUND) revert NotFund();
        _;
    }

    constructor(address fund_, IERC20 usdg_) {
        FUND = fund_;
        USDG = usdg_;
    }

    /// @notice Registra el funding de un settlement. El USDG llega directamente desde el
    /// StakeEscrow (`slash(amount, reserve)`); este método exige que la caja lo respalde.
    function creditPeriod(uint64 period, uint256 amount) external onlyFund {
        funded[period] += amount;
        totalFunded += amount;
        if (USDG.balanceOf(address(this)) < totalFunded - totalPaid) revert UnderCollateralized();
        emit PeriodFunded(period, amount);
    }

    /// @notice Paga un claim materializado por el Fund. Invariante: nunca más que el funding del período.
    function pay(uint64 period, address lp, uint256 amount) external onlyFund {
        uint256 newPaid = paid[period] + amount;
        if (newPaid > funded[period]) revert ExceedsFunding();
        paid[period] = newPaid;
        totalPaid += amount;
        USDG.safeTransfer(lp, amount);
        emit ClaimPaid(period, lp, amount);
    }

    /// @notice Rollover v0.7: el residuo no adjudicado de un período rueda como funding de otro
    /// posterior — jamás vuelve al manager (anti colusión keeper-manager). La política de CUÁNTO
    /// es seguro rodar (claims perezosos aún no materializados) vive en el Fund.
    function rollover(uint64 fromPeriod, uint64 toPeriod, uint256 amount) external onlyFund {
        if (toPeriod <= fromPeriod) revert ExceedsFunding();
        if (amount > funded[fromPeriod] - paid[fromPeriod]) revert ExceedsFunding();
        funded[fromPeriod] -= amount;
        funded[toPeriod] += amount;
        emit RolledOver(fromPeriod, toPeriod, amount);
    }

    function unclaimed(uint64 period) external view returns (uint256) {
        return funded[period] - paid[period];
    }
}
