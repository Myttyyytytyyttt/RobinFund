// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {TokenRegistry} from "../TokenRegistry.sol";
import {IStockToken, IAccessControlledRegistry} from "../interfaces/IStockToken.sol";
import {IAggregatorV3} from "../interfaces/IAggregatorV3.sol";
import {IERC20} from "../interfaces/IERC20.sol";

/// @title NAVLib — valoración WAD y validez del NAV (SPEC §5.1–§5.2, v0.8)
/// @notice Reglas verificadas on-chain en Fase 0:
///  · USDG tiene 6 decimales → ×1e12 a WAD; su feed (si existe) va en 8 dec.
///  · Los feeds de Stock Tokens son 8 dec y YA incluyen el uiMultiplier — nunca aplicarlo encima.
///  · No existe sequencer uptime feed en chain 4663 — la validez no lo comprueba (SPEC §5.2.3).
///  · `oraclePaused()`/`tokenPaused()`/`paused()` viven en el propio token.
library NAVLib {
    /// @dev Posiciones con valor ≤ $10 (WAD) se valoran a cero y no invalidan el NAV (SPEC §5.2.4, C17).
    uint256 internal constant DUST_THRESHOLD_WAD = 10e18;
    uint256 internal constant USDG_TO_WAD = 1e12; // 6 dec → 18 dec
    uint256 internal constant FEED_UNIT = 1e8; // feeds 8 dec

    struct AssetView {
        address token;
        uint256 rawBalance;
        uint256 valueWad; // con el último precio disponible (aunque sea stale)
        bool dust; // valor ≤ DUST: suma 0 y no invalida
        bool ok; // contribuye a un NAV válido
    }

    struct Snapshot {
        uint256 navWad; // Σ valores (dust cuenta 0)
        bool valid; // isNavValid() del SPEC §5.2
    }

    /// @notice Calcula NAV y validez para `fund` sobre `tokens` + su sleeve de USDG.
    /// @dev `tokens` es la lista de activos del fondo (el Fund la mantiene); el escrow de colas
    /// y la CompensationReserve viven en contratos separados y por construcción no entran aquí.
    function compute(TokenRegistry reg, address fund, address[] memory tokens)
        internal
        view
        returns (Snapshot memory s)
    {
        s.valid = true;

        // Condición 1 (SPEC §5.2.1, C30): el fondo no está bloqueado por RHJ y el registry no está en pausa global.
        IAccessControlledRegistry access = reg.accessRegistry();
        if (address(access) != address(0)) {
            if (access.isBlocked(fund) || access.paused()) s.valid = false;
        }

        // Sleeve USDG (§5.1): 6 dec → WAD, valorado al feed USDG/USD si está configurado.
        s.navWad += usdgValueWad(reg, IERC20(reg.USDG()).balanceOf(fund), s);

        for (uint256 i; i < tokens.length; ++i) {
            AssetView memory av = valueAsset(reg, fund, tokens[i]);
            s.navWad += av.dust ? 0 : av.valueWad;
            if (!av.dust && !av.ok) s.valid = false;
        }
    }

    /// @notice Valora el sleeve USDG. Si hay feed configurado y está stale/roto, invalida el NAV.
    function usdgValueWad(TokenRegistry reg, uint256 usdgBal6, Snapshot memory s) internal view returns (uint256) {
        uint256 balWad = usdgBal6 * USDG_TO_WAD;
        address feed = reg.usdgFeed();
        if (feed == address(0)) return balWad; // supuesto 1:1 documentado (SPEC §5.5)

        (, int256 px,, uint256 updatedAt,) = IAggregatorV3(feed).latestRoundData();
        bool broken = px <= 0 || block.timestamp - updatedAt > reg.usdgMaxStaleness();
        // El USDG es la moneda de denominación: feed roto/stale invalida salvo que el sleeve sea dust.
        if (broken && balWad > DUST_THRESHOLD_WAD) s.valid = false;
        if (px <= 0) return balWad; // sin precio utilizable: 1:1 solo para reporting
        return balWad * uint256(px) / FEED_UNIT;
    }

    /// @notice Valora una posición y evalúa las condiciones §5.2.2/§5.2.4 para ella.
    function valueAsset(TokenRegistry reg, address fund, address token) internal view returns (AssetView memory av) {
        av.token = token;
        av.rawBalance = IERC20(token).balanceOf(fund);
        if (av.rawBalance == 0) {
            av.dust = true; // sin posición: no invalida, no suma
            return av;
        }

        (address feed, uint48 maxStaleness) = reg.feedOf(token);
        int256 px;
        uint256 updatedAt;
        if (feed != address(0)) {
            (, px,, updatedAt,) = IAggregatorV3(feed).latestRoundData();
        }

        // Valor con el último precio disponible — también sirve para la decisión de dust.
        av.valueWad = px > 0 ? av.rawBalance * uint256(px) / FEED_UNIT : 0;
        if (px > 0 && av.valueWad <= DUST_THRESHOLD_WAD) {
            av.dust = true; // §5.2.4: dust se valora a cero y no invalida
            return av;
        }

        // No-dust: todas las condiciones deben cumplirse.
        av.ok = reg.isActive(token) // listado y sin suspensión (drift de beacon, C29)
            && px > 0 // sin precio no hay dust-decision fiable: inválido
            && !IStockToken(token).paused() // §5.2.2: pausa por token o global del emisor
            && !IStockToken(token).oraclePaused() // corporate action en proceso (§3, verificado en token)
            && block.timestamp - updatedAt <= maxStaleness; // §5.2.4, heartbeat real 86400s + margen
    }
}
