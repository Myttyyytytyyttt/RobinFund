// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20} from "./interfaces/IERC20.sol";
import {SafeTransferLib} from "./libraries/SafeTransferLib.sol";

interface IFundLike {
    function share() external view returns (address);
    function requestWithdraw(uint256 shares, bool inKind) external returns (uint256);
}

interface IFundShareLike {
    function balanceOf(address) external view returns (uint256);
}

/// @title FeeSplitter — reparte la performance fee (SPEC §7.2, §7.3)
/// @notice El Fund mintea las shares de perf fee a este contrato (excluido de la contabilidad NI).
/// Para realizarlas, `redeem` las mete en la cola de retiro del Fund; cuando el USDG llega,
/// `distribute` lo reparte 90% manager / 10% protocolo. Uno por fondo (desplegado por la factory).
/// El manager cobra "por la cola normal" como cualquier holder — con el mismo cooldown y forward pricing.
contract FeeSplitter {
    using SafeTransferLib for IERC20;

    uint256 internal constant MANAGER_BPS = 9000; // 90% (SPEC §7.2)

    address public immutable FUND;
    IERC20 public immutable USDG;
    address public immutable MANAGER;
    address public immutable PROTOCOL_TREASURY;

    event Redeemed(uint256 shares);
    event Distributed(uint256 toManager, uint256 toProtocol);

    error ZeroAddress();

    constructor(address fund_, IERC20 usdg_, address manager_, address treasury_) {
        if (fund_ == address(0) || manager_ == address(0) || treasury_ == address(0)) revert ZeroAddress();
        FUND = fund_;
        USDG = usdg_;
        MANAGER = manager_;
        PROTOCOL_TREASURY = treasury_;
    }

    /// @notice Encola el retiro de las shares de fee acumuladas (permissionless — el manager/keeper
    /// lo dispara). Retiro cash a NAV: el USDG llega tras el cooldown, y `distribute` lo reparte.
    function redeem() external returns (uint256 shares) {
        shares = IFundShareLike(IFundLike(FUND).share()).balanceOf(address(this));
        if (shares > 0) {
            IFundLike(FUND).requestWithdraw(shares, false);
        }
        emit Redeemed(shares);
    }

    /// @notice Reparte el USDG disponible 90/10. Permissionless.
    function distribute() external {
        uint256 bal = USDG.balanceOf(address(this));
        if (bal == 0) return;
        uint256 toManager = bal * MANAGER_BPS / 10000;
        uint256 toProtocol = bal - toManager;
        USDG.safeTransfer(MANAGER, toManager);
        USDG.safeTransfer(PROTOCOL_TREASURY, toProtocol);
        emit Distributed(toManager, toProtocol);
    }
}
