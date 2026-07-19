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

    function setUp() public {
        vm.warp(10_000_000); // timestamp realista
        access = new MockAccessRegistry();
        tsla = new MockStockToken("TSLA", access);
        usdg = new MockUSDG();
        tslaFeed = new MockFeed(380_00000000); // $380, 8 dec
        usdgFeed = new MockFeed(1_00000000); // $1.00
        reg = new TokenRegistry(address(usdg));
        reg.list(address(tsla), address(tslaFeed), STALENESS);
        nav = new NavHarness();
    }

    function _tokens() internal view returns (address[] memory t) {
        t = new address[](1);
        t[0] = address(tsla);
    }

    // --- Valoración (§5.1, unidades §3.1) ---

    function test_usdg_6dec_a_wad() public {
        usdg.mint(fund, 1_500000); // 1.5 USDG (6 dec)
        NAVLib.Snapshot memory s = nav.compute(reg, fund, _tokens());
        assertEq(s.navWad, 1.5e18, "1.5 USDG = 1.5e18 WAD");
        assertTrue(s.valid);
    }

    function test_stock_valorado_por_feed() public {
        tsla.mint(fund, 2e18); // 2 TSLA
        NAVLib.Snapshot memory s = nav.compute(reg, fund, _tokens());
        assertEq(s.navWad, 760e18, "2 x $380");
        assertTrue(s.valid);
    }

    function test_mezcla_usdg_y_stock() public {
        usdg.mint(fund, 100_000000); // 100 USDG
        tsla.mint(fund, 1e18);
        NAVLib.Snapshot memory s = nav.compute(reg, fund, _tokens());
        assertEq(s.navWad, 480e18);
    }

    function test_usdg_con_feed_depeg() public {
        reg.setUsdgFeed(address(usdgFeed), STALENESS);
        usdgFeed.set(97000000, block.timestamp); // $0.97
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
        assertFalse(s.valid, "stale > maxStaleness invalida");
        assertEq(s.navWad, 380e18, "NAV se reporta igual con el ultimo precio");
    }

    function test_feed_en_el_limite_de_staleness_valido() public {
        tsla.mint(fund, 1e18);
        tslaFeed.set(380_00000000, block.timestamp - STALENESS);
        assertTrue(nav.compute(reg, fund, _tokens()).valid, "exactamente en el limite: valido");
    }

    function test_dust_stale_no_invalida() public {
        // $3.80 de TSLA con feed stale: dust → cuenta 0 y no invalida (§5.2.4, C17)
        tsla.mint(fund, 0.01e18);
        tslaFeed.set(380_00000000, block.timestamp - 30 days);
        usdg.mint(fund, 50_000000);
        NAVLib.Snapshot memory s = nav.compute(reg, fund, _tokens());
        assertTrue(s.valid, "dust no invalida");
        assertEq(s.navWad, 50e18, "dust cuenta 0");
    }

    function test_token_pausado_invalida() public {
        tsla.mint(fund, 1e18);
        tsla.setTokenPaused(true);
        assertFalse(nav.compute(reg, fund, _tokens()).valid);
    }

    function test_pausa_global_del_emisor_invalida() public {
        tsla.mint(fund, 1e18);
        access.setPaused(true);
        assertFalse(nav.compute(reg, fund, _tokens()).valid, "pausa global: paused() del token + registry");
    }

    function test_oraculo_pausado_invalida() public {
        // corporate action en proceso (§3): oraclePaused vive en el token (verificado Fase 0)
        tsla.mint(fund, 1e18);
        tsla.setOraclePaused(true);
        assertFalse(nav.compute(reg, fund, _tokens()).valid);
    }

    function test_fondo_bloqueado_invalida() public {
        usdg.mint(fund, 100_000000);
        access.setBlocked(fund, true);
        assertFalse(nav.compute(reg, fund, _tokens()).valid, "C30: isBlocked(fund) on-chain");
    }

    function test_activo_suspendido_invalida() public {
        tsla.mint(fund, 1e18);
        reg.suspend(address(tsla));
        assertFalse(nav.compute(reg, fund, _tokens()).valid);
    }

    function test_posicion_cero_no_invalida() public {
        usdg.mint(fund, 10_000000);
        tslaFeed.set(380_00000000, block.timestamp - 30 days); // feed muerto pero balance 0
        assertTrue(nav.compute(reg, fund, _tokens()).valid);
    }

    function test_usdg_feed_stale_invalida_si_sleeve_no_dust() public {
        reg.setUsdgFeed(address(usdgFeed), STALENESS);
        usdgFeed.set(1_00000000, block.timestamp - STALENESS - 1);
        usdg.mint(fund, 100_000000); // $100 > dust
        assertFalse(nav.compute(reg, fund, _tokens()).valid);
    }

    function test_usdg_feed_stale_con_sleeve_dust_no_invalida() public {
        reg.setUsdgFeed(address(usdgFeed), STALENESS);
        usdgFeed.set(1_00000000, block.timestamp - STALENESS - 1);
        usdg.mint(fund, 5_000000); // $5 ≤ dust
        tsla.mint(fund, 1e18);
        assertTrue(nav.compute(reg, fund, _tokens()).valid);
    }
}
