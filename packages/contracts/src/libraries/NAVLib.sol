// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {TokenRegistry} from "../TokenRegistry.sol";
import {IStockToken, IAccessControlledRegistry} from "../interfaces/IStockToken.sol";
import {IAggregatorV3} from "../interfaces/IAggregatorV3.sol";
import {IERC20} from "../interfaces/IERC20.sol";

/// @title NAVLib — valoración WAD y validez del NAV (SPEC §5.1–§5.2, v0.8 + revisión 1.1)
/// @notice Principio de diseño (revisión F1): NINGUNA llamada externa puede revertir el cálculo.
/// Los Stock Tokens son beacon proxies upgradeables por el emisor y los feeds pueden morir —
/// todo fallo externo degrada a `valid = false`, jamás a revert. El estado de oráculo malo
/// produce un NAV INVÁLIDO, nunca un NAV indisponible.
/// Hechos verificados on-chain (Fase 0 + revisión): USDG 6 dec; feeds 8 dec multiplier-inclusive;
/// sin sequencer uptime feed; el ACCESS_CONTROLLED_REGISTRY es el beacon ERC-1967 de los tokens.
library NAVLib {
    /// @dev Posiciones con valor ≤ $10 (WAD) se valoran a cero y no invalidan el NAV (§5.2, C17).
    uint256 internal constant DUST_THRESHOLD_WAD = 10e18;
    uint256 internal constant USDG_TO_WAD = 1e12; // 6 dec → 18 dec
    uint256 internal constant FEED_UNIT = 1e8; // feeds 8 dec

    /// @dev La lista de tokens del Fund debe venir estrictamente ordenada (sin duplicados, F13).
    error UnsortedTokens();

    struct AssetView {
        address token;
        uint256 rawBalance;
        uint256 valueWad; // mejor esfuerzo con el último precio en-banda (para reporting)
        bool dust; // valor ≤ DUST con precio sano: suma 0 y no invalida
        bool ok; // contribuye a un NAV válido
    }

    struct Snapshot {
        uint256 navWad; // Σ valores (dust cuenta 0)
        bool valid; // isNavValid() del SPEC §5.2
    }

    /// @notice Calcula NAV y validez para `fund` sobre `tokens` (estrictamente ordenada) + sleeve USDG.
    function compute(TokenRegistry reg, address fund, address[] memory tokens)
        internal
        view
        returns (Snapshot memory s)
    {
        s.valid = true;
        bool hasNonDustStock;

        for (uint256 i; i < tokens.length; ++i) {
            if (i > 0 && tokens[i] <= tokens[i - 1]) revert UnsortedTokens(); // invariante del Fund, F13
            AssetView memory av = valueAsset(reg, fund, tokens[i]);
            if (!av.dust) {
                hasNonDustStock = true;
                s.navWad += av.valueWad;
                if (!av.ok) s.valid = false;
            }
        }

        // Sleeve USDG (§5.1) — puede invalidar si su feed está roto y el sleeve no es dust (§5.2.5).
        s.navWad += _usdgValueWad(reg, fund, s);

        // Condición §5.2.1 (C30): fondo bloqueado por RHJ ⇒ inválido, incondicionalmente.
        // Pausa GLOBAL del emisor: solo invalida si hay posición de stock no-dust (F9, dust-exemption).
        (bool accessOk, bool fundBlocked, bool registryPaused) = _tryAccessStatus(reg, fund);
        if (!accessOk || fundBlocked) s.valid = false;
        else if (registryPaused && hasNonDustStock) s.valid = false;
    }

    /// @notice Valora una posición evaluando §5.2.2/§5.2.4 para ella. Nunca revierte por fallo externo.
    function valueAsset(TokenRegistry reg, address fund, address token) internal view returns (AssetView memory av) {
        av.token = token;

        (bool balOk, uint256 bal) = _tryBalanceOf(token, fund);
        av.rawBalance = bal;
        if (!balOk) return av; // balanceOf revierte (upgrade hostil): no-dust, ok=false ⇒ inválido (F1)
        if (bal == 0) {
            av.dust = true; // sin posición: no suma ni invalida — aunque el feed esté muerto
            return av;
        }

        TokenRegistry.Asset memory a = reg.getAsset(token);
        (bool feedOk, int256 px, uint256 updatedAt) = _tryLatest(a.feed);

        // Banda de cordura del precio (F2): fuera de banda NO se valora ni clasifica dust.
        bool inBand = feedOk && px >= a.minAnswer && px <= a.maxAnswer;
        if (inBand) {
            av.valueWad = bal * uint256(px) / FEED_UNIT;
            if (av.valueWad <= DUST_THRESHOLD_WAD) {
                av.dust = true; // §5.2.4 — la clasificación dust exige precio EN BANDA (F2)
                return av;
            }
        }

        // No-dust: todas las condiciones. updatedAt futuro = roto, no underflow (F7/F12).
        bool fresh = feedOk && updatedAt <= block.timestamp && block.timestamp - updatedAt <= a.maxStaleness;
        (bool pauseOk, bool anyPaused) = _tryPauses(token);

        av.ok = a.listed && !a.suspended // condición 5 (suspensión por drift de beacon, C29/F10)
            && inBand && fresh // §5.2.4 + bandas F2
            && pauseOk && !anyPaused; // §5.2.2: paused() ∪ tokenPaused() ∪ oraclePaused() (F3)
    }

    // ---------- Llamadas externas blindadas (F1): fallo ⇒ degradación, nunca revert ----------

    function _tryBalanceOf(address t, address a) private view returns (bool, uint256) {
        try IERC20(t).balanceOf(a) returns (uint256 b) {
            return (true, b);
        } catch {
            return (false, 0);
        }
    }

    function _tryLatest(address feed) private view returns (bool, int256, uint256) {
        if (feed == address(0)) return (false, 0, 0);
        try IAggregatorV3(feed).latestRoundData() returns (uint80, int256 px, uint256, uint256 upd, uint80) {
            return (px > 0, px, upd);
        } catch {
            return (false, 0, 0);
        }
    }

    /// @dev paused() ya combina tokenPaused ∪ pausa global en el contrato real, pero comprobamos
    /// también tokenPaused() y oraclePaused() explícitamente (F3): un upgrade podría separarlos.
    function _tryPauses(address token) private view returns (bool ok, bool anyPaused) {
        IStockToken t = IStockToken(token);
        bool p1;
        bool p2;
        bool p3;
        try t.paused() returns (bool v) {
            p1 = v;
        } catch {
            return (false, true);
        }
        try t.tokenPaused() returns (bool v) {
            p2 = v;
        } catch {
            return (false, true);
        }
        try t.oraclePaused() returns (bool v) {
            p3 = v;
        } catch {
            return (false, true);
        }
        return (true, p1 || p2 || p3);
    }

    function _tryAccessStatus(TokenRegistry reg, address fund)
        private
        view
        returns (bool ok, bool blocked, bool paused_)
    {
        IAccessControlledRegistry access = reg.accessRegistry();
        if (address(access) == address(0)) return (true, false, false); // registry sin activos listados
        try access.isBlocked(fund) returns (bool b) {
            blocked = b;
        } catch {
            return (false, true, true);
        }
        try access.paused() returns (bool p) {
            paused_ = p;
        } catch {
            return (false, true, true);
        }
        ok = true;
    }

    /// @dev USDG es la moneda de denominación (proxy de Paxos — también upgradeable: try/catch).
    function _usdgValueWad(TokenRegistry reg, address fund, Snapshot memory s) private view returns (uint256) {
        (bool balOk, uint256 bal6) = _tryBalanceOf(reg.USDG(), fund);
        if (!balOk) {
            s.valid = false; // USDG.balanceOf revirtiendo: inválido, reporta 0
            return 0;
        }
        uint256 balWad = bal6 * USDG_TO_WAD;
        address feed = reg.usdgFeed();
        if (feed == address(0)) return balWad; // modo degradado 1:1 (§5.5 — el deploy debe configurar el feed)

        (bool feedOk, int256 px, uint256 updatedAt) = _tryLatest(feed);
        bool fresh = feedOk && updatedAt <= block.timestamp && block.timestamp - updatedAt <= reg.usdgMaxStaleness();
        bool inBand = feedOk && px >= reg.usdgMinAnswer() && px <= reg.usdgMaxAnswer();
        if (!(fresh && inBand)) {
            if (balWad > DUST_THRESHOLD_WAD) s.valid = false; // §5.2.5 (F17): feed del numerario roto
            return balWad; // reporting 1:1
        }
        return balWad * uint256(px) / FEED_UNIT;
    }
}
