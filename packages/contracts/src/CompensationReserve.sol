// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20} from "./interfaces/IERC20.sol";
import {SafeTransferLib} from "./libraries/SafeTransferLib.sol";

/// @title CompensationReserve — funding y claims pull del first-loss, por período (SPEC §6, rev. 1.2)
/// @notice Contrato separado del Fund (§10.3: los claims ya adjudicados siguen pagándose en Frozen —
/// el Fund bloqueado sigue pudiendo LLAMAR aunque sus tokens estén congelados). Invariantes de caja:
///  · `Σ pagado(período) ≤ fondeado(período)` — forzado on-chain (§6)
///  · el funding registrado debe estar respaldado por caja real
///  · el residuo solo sale vía `sweep`, cuya única invocación legítima es el estado Closed del Fund
///    con `totalShares == 0`: en ese punto todo LP ha materializado (el burn es un touch), así que
///    `funded − paid` es PROVABLEMENTE inreclamable y vuelve al manager (política v0.9 — sustituye
///    al rollover de v0.7, que era incomputable con claims perezosos; hallazgo G2 de la revisión).
/// El destinatario de `pay` no se restringe (el manager puede ser LP legítimo); la honestidad de la
/// materialización es responsabilidad del Fund (G10 — documentado, no exigible aquí).
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
    event ResidualSwept(uint64 indexed period, address indexed to, uint256 amount);

    error ZeroAddress();
    error NotFund();
    error ExceedsFunding();
    error UnderCollateralized();

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

    /// @notice Registra el funding de un settlement (el USDG llega del StakeEscrow.slash, que solo
    /// puede pagar aquí). Exige que la caja respalde todo lo fondeado no pagado.
    function creditPeriod(uint64 period, uint256 amount) external onlyFund {
        funded[period] += amount;
        totalFunded += amount;
        if (USDG.balanceOf(address(this)) < totalFunded - totalPaid) revert UnderCollateralized();
        emit PeriodFunded(period, amount);
    }

    /// @notice Paga un claim materializado por el Fund. Nunca más que el funding del período.
    function pay(uint64 period, address lp, uint256 amount) external onlyFund {
        uint256 newPaid = paid[period] + amount;
        if (newPaid > funded[period]) revert ExceedsFunding();
        paid[period] = newPaid;
        totalPaid += amount;
        USDG.safeTransfer(lp, amount);
        emit ClaimPaid(period, lp, amount);
    }

    /// @notice Barre el residuo de un período. Única invocación legítima: Closed con totalShares = 0
    /// (residuo provablemente inreclamable → manager). La disciplina del call-site es del Fund y
    /// debe cubrirse con un invariant test (SPEC §6 v0.9).
    function sweep(uint64 period, address to) external onlyFund returns (uint256 amount) {
        amount = funded[period] - paid[period];
        paid[period] = funded[period];
        totalPaid += amount;
        USDG.safeTransfer(to, amount);
        emit ResidualSwept(period, to, amount);
    }

    function unclaimed(uint64 period) external view returns (uint256) {
        return funded[period] - paid[period];
    }
}
