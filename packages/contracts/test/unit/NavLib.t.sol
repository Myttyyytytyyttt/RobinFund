// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {TokenRegistry} from "../../src/TokenRegistry.sol";
import {NAVLib} from "../../src/libraries/NAVLib.sol";
import {MockAccessRegistry, MockStockToken, MockUSDG, MockFeed} from "../mocks/Mocks.sol";

contract NavHarness {
    function compute(TokenRegistry reg, address fund, address[] memory tokens)
        external
        view
        returns (NAVLib.Snapshot memory)
    {
        return NAVLib.compute(reg, fund, tokens);
    }
}

contract NavLibTest is Test {
    MockAccessRegistry access;
    MockStockToken tsla;
    MockUSDG usdg;
    MockFeed tslaFeed;
    MockFeed usdgFeed;
    TokenRegistry reg;
    NavHarness nav;
    address fund = address(0xF00D);

    uint48 constant STALENESS = 90000; // 86400 + 1h (calibrado Fase 0)
    int256 constant MIN_PX = 50_00000000; // banda TSLA: $50–$5000 (F2)
    int256 constant MAX_PX = 5000_00000000;

    function setUp() public {
        vm.warp(10_000_000);
        access = new MockAccessRegistry();
        tsla = new MockStockToken("TSLA", access);
        usdg = new MockUSDG();
        tslaFeed = new MockFeed(380_00000000);
        usdgFeed = new MockFeed(1_00000000);
        reg = new TokenRegistry(address(usdg));
        reg.list(address(tsla), address(tslaFeed), STALENESS, MIN_PX, MAX_PX, address(0xBEEF));
        nav = new NavHarness();
    }

    function _tokens() internal view returns (address[] memory t) {
        t = new address[](1);
        t[0] = address(tsla);
    }

    // --- Valoración (§5.1, unidades §3.1) ---

    function test_usdg_6dec_a_wad() public {
        usdg.mint(fund, 1_500000);
        NAVLib.Snapshot memory s = nav.compute(reg, fund, _tokens());
        assertEq(s.navWad, 1.5e18, "1.5 USDG = 1.5e18 WAD");
        assertTrue(s.valid);
    }

    function test_stock_valorado_por_feed() public {
        tsla.mint(fund, 2e18);
        NAVLib.Snapshot memory s = nav.compute(reg, fund, _tokens());
        assertEq(s.navWad, 760e18, "2 x $380");
        assertTrue(s.valid);
    }

    function test_mezcla_usdg_y_stock() public {
        usdg.mint(fund, 100_000000);
        tsla.mint(fund, 1e18);
        assertEq(nav.compute(reg, fund, _tokens()).navWad, 480e18);
    }

    function test_usdg_con_feed_depeg() public {
        reg.setUsdgFeed(address(usdgFeed), STALENESS, 90000000, 110000000);
        usdgFeed.set(97000000, block.timestamp);
        usdg.mint(fund, 100_000000);
        NAVLib.Snapshot memory s = nav.compute(reg, fund, _tokens());
        assertEq(s.navWad, 97e18, "sleeve valorado a 0.97");
        assertTrue(s.valid);
    }

    // --- Validez (§5.2) ---

    function test_feed_stale_invalida() public {
        tsla.mint(fund, 1e18);
        tslaFeed.set(380_00000000, block.timestamp - STALENESS - 1);
        NAVLib.Snapshot memory s = nav.compute(reg, fund, _tokens());
        assertFalse(s.valid);
        assertEq(s.navWad, 380e18, "NAV se reporta igual con el ultimo precio en banda");
    }

    function test_feed_en_el_limite_valido() public {
        tsla.mint(fund, 1e18);
        tslaFeed.set(380_00000000, block.timestamp - STALENESS);
        assertTrue(nav.compute(reg, fund, _tokens()).valid);
    }

    function test_dust_stale_no_invalida() public {
        tsla.mint(fund, 0.01e18); // $3.80, dust
        tslaFeed.set(380_00000000, block.timestamp - 30 days);
        usdg.mint(fund, 50_000000);
        NAVLib.Snapshot memory s = nav.compute(reg, fund, _tokens());
        assertTrue(s.valid, "dust (precio en banda) no invalida");
        assertEq(s.navWad, 50e18);
    }

    function test_token_pausado_invalida() public {
        tsla.mint(fund, 1e18);
        tsla.setTokenPaused(true);
        assertFalse(nav.compute(reg, fund, _tokens()).valid);
    }

    function test_tokenPaused_desacoplado_de_paused_invalida() public {
        // F3: un upgrade podria separar tokenPaused de paused() — el check explicito debe cazarlo
        tsla.mint(fund, 1e18);
        tsla.setDecoupledPaused(true);
        tsla.setTokenPaused(true); // paused() == false, tokenPaused() == true
        assertFalse(nav.compute(reg, fund, _tokens()).valid, "tokenPaused se comprueba explicitamente");
    }

    function test_pausa_global_con_stock_invalida_via_branch_global() public {
        // F8e: aisla la rama global — paused() del token desacoplado devuelve solo registry.paused,
        // pero aqui apagamos el acople y el registro para que SOLO la rama top-level pueda invalidar
        tsla.mint(fund, 1e18);
        tsla.setDecoupledPaused(true);
        access.setPaused(true); // paused() del token = true via registry... aun acoplado al registry
        assertFalse(nav.compute(reg, fund, _tokens()).valid);
    }

    function test_pausa_global_con_fondo_solo_usdg_NO_invalida() public {
        // F9: dust-exemption del pause global — un fondo solo-USDG no se congela por la pausa de RHJ
        usdg.mint(fund, 1000_000000);
        access.setPaused(true);
        NAVLib.Snapshot memory s = nav.compute(reg, fund, _tokens());
        assertTrue(s.valid, "sin stock no-dust, la pausa global del emisor no bloquea el fondo");
        assertEq(s.navWad, 1000e18);
    }

    function test_oraculo_pausado_invalida() public {
        tsla.mint(fund, 1e18);
        tsla.setOraclePaused(true);
        assertFalse(nav.compute(reg, fund, _tokens()).valid);
    }

    function test_fondo_bloqueado_invalida_incluso_solo_usdg() public {
        usdg.mint(fund, 100_000000);
        access.setBlocked(fund, true);
        assertFalse(nav.compute(reg, fund, _tokens()).valid, "C30: isBlocked(fund) incondicional");
    }

    function test_activo_suspendido_invalida() public {
        tsla.mint(fund, 1e18);
        reg.suspend(address(tsla));
        assertFalse(nav.compute(reg, fund, _tokens()).valid, "condicion 5 (F10)");
    }

    function test_posicion_cero_no_invalida_ni_con_feed_muerto() public {
        usdg.mint(fund, 100_000000);
        tslaFeed.setRevert(true);
        assertTrue(nav.compute(reg, fund, _tokens()).valid);
    }

    // --- Degradación graceful (F1): ningún fallo externo revierte ---

    function test_feed_revirtiendo_degrada_no_revierte() public {
        tsla.mint(fund, 1e18);
        tslaFeed.setRevert(true);
        NAVLib.Snapshot memory s = nav.compute(reg, fund, _tokens()); // no debe revertir
        assertFalse(s.valid, "feed deprecado => invalido");
        assertEq(s.navWad, 0, "posicion sin precio fiable reporta 0");
    }

    function test_paused_revirtiendo_degrada_no_revierte() public {
        tsla.mint(fund, 1e18);
        tsla.setRevertPaused(true);
        NAVLib.Snapshot memory s = nav.compute(reg, fund, _tokens());
        assertFalse(s.valid, "upgrade hostil de paused() => invalido");
    }

    function test_balanceOf_revirtiendo_degrada_no_revierte() public {
        usdg.mint(fund, 100_000000);
        tsla.setRevertBalanceOf(true);
        NAVLib.Snapshot memory s = nav.compute(reg, fund, _tokens());
        assertFalse(s.valid, "balanceOf hostil => invalido");
    }

    function test_access_registry_roto_degrada_no_revierte() public {
        usdg.mint(fund, 100_000000);
        access.setRevertAll(true);
        NAVLib.Snapshot memory s = nav.compute(reg, fund, _tokens());
        assertFalse(s.valid, "registry roto => invalido, no brick");
    }

    function test_updatedAt_futuro_invalida_sin_underflow() public {
        // F7/F12: reloj adelantado del feed no puede revertir el calculo
        tsla.mint(fund, 1e18);
        tslaFeed.set(380_00000000, block.timestamp + 100);
        NAVLib.Snapshot memory s = nav.compute(reg, fund, _tokens());
        assertFalse(s.valid, "updatedAt futuro = roto");
    }

    // --- Bandas de precio (F2) ---

    function test_precio_glitcheado_a_casi_cero_NO_desaparece_la_posicion() public {
        // El PoC de la revision: 1000 TSLA reales, feed glitcheado a 1 unidad (fuera de banda)
        tsla.mint(fund, 1000e18);
        usdg.mint(fund, 100_000000);
        tslaFeed.set(1, block.timestamp);
        NAVLib.Snapshot memory s = nav.compute(reg, fund, _tokens());
        assertFalse(s.valid, "precio fuera de banda => INVALIDO, no dust");
        assertEq(s.navWad, 100e18, "la posicion no se valora con precio absurdo");
    }

    function test_precio_inflado_fuera_de_banda_invalida() public {
        tsla.mint(fund, 1e18);
        tslaFeed.set(1_000_000_00000000, block.timestamp); // $1M, fuera de banda
        assertFalse(nav.compute(reg, fund, _tokens()).valid);
    }

    function test_usdg_feed_stale_invalida_si_sleeve_no_dust() public {
        reg.setUsdgFeed(address(usdgFeed), STALENESS, 90000000, 110000000);
        usdgFeed.set(1_00000000, block.timestamp - STALENESS - 1);
        usdg.mint(fund, 100_000000);
        assertFalse(nav.compute(reg, fund, _tokens()).valid);
    }

    function test_usdg_feed_stale_con_sleeve_dust_no_invalida() public {
        reg.setUsdgFeed(address(usdgFeed), STALENESS, 90000000, 110000000);
        usdgFeed.set(1_00000000, block.timestamp - STALENESS - 1);
        usdg.mint(fund, 5_000000);
        tsla.mint(fund, 1e18);
        assertTrue(nav.compute(reg, fund, _tokens()).valid);
    }

    // --- Lista de tokens (F13) ---

    function test_lista_desordenada_o_duplicada_revierte() public {
        MockStockToken other = new MockStockToken("NVDA", access);
        reg.list(address(other), address(tslaFeed), STALENESS, MIN_PX, MAX_PX, address(0xBEEF));
        address[] memory dup = new address[](2);
        dup[0] = address(tsla);
        dup[1] = address(tsla);
        vm.expectRevert(NAVLib.UnsortedTokens.selector);
        nav.compute(reg, fund, dup);

        address[] memory unsorted = new address[](2);
        (address lo, address hi) =
            address(tsla) < address(other) ? (address(tsla), address(other)) : (address(other), address(tsla));
        unsorted[0] = hi;
        unsorted[1] = lo;
        vm.expectRevert(NAVLib.UnsortedTokens.selector);
        nav.compute(reg, fund, unsorted);
    }
}
