// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {TokenRegistry} from "../../src/TokenRegistry.sol";
import {MockAccessRegistry, MockStockToken, MockUSDG, MockFeed} from "../mocks/Mocks.sol";

contract TokenRegistryTest is Test {
    MockAccessRegistry access;
    MockStockToken tsla;
    MockUSDG usdg;
    MockFeed feed;
    TokenRegistry reg;

    int256 constant MIN_PX = 50_00000000;
    int256 constant MAX_PX = 5000_00000000;
    uint48 constant STALENESS = 90000;

    function setUp() public {
        access = new MockAccessRegistry();
        tsla = new MockStockToken("TSLA", access);
        usdg = new MockUSDG();
        feed = new MockFeed(380_00000000);
        reg = new TokenRegistry(address(usdg));
    }

    function _list(address token) internal {
        reg.list(token, address(feed), STALENESS, MIN_PX, MAX_PX, address(0xBEEF));
    }

    function test_list_captura_beacon_e_impl() public {
        _list(address(tsla));
        TokenRegistry.Asset memory a = reg.getAsset(address(tsla));
        assertTrue(a.listed);
        assertEq(a.beacon, address(access));
        assertEq(a.implAtListing, address(0xBEEF));
        assertEq(a.minAnswer, MIN_PX);
        assertEq(address(reg.accessRegistry()), address(access));
        assertTrue(reg.isActive(address(tsla)));
    }

    function test_list_con_impl_inesperada_revierte() public {
        // F5: el owner commitea la impl exacta revisada — front-run del emisor => revert
        vm.expectRevert(abi.encodeWithSelector(TokenRegistry.ImplMismatch.selector, address(0xBEEF)));
        reg.list(address(tsla), address(feed), STALENESS, MIN_PX, MAX_PX, address(0xCAFE));
    }

    function test_list_rechaza_feed_invalido_y_bandas_malas() public {
        MockFeed bad = new MockFeed(0);
        vm.expectRevert(TokenRegistry.BadFeed.selector);
        reg.list(address(tsla), address(bad), STALENESS, MIN_PX, MAX_PX, address(0xBEEF));

        // precio actual fuera de la banda propuesta
        vm.expectRevert(TokenRegistry.BadBounds.selector);
        reg.list(address(tsla), address(feed), STALENESS, 400_00000000, 5000_00000000, address(0xBEEF));
    }

    function test_list_rechaza_staleness_fuera_de_rango() public {
        // F18: un typo en maxStaleness no puede brickear los flujos del fondo
        vm.expectRevert(TokenRegistry.BadStaleness.selector);
        reg.list(address(tsla), address(feed), 0, MIN_PX, MAX_PX, address(0xBEEF));
        vm.expectRevert(TokenRegistry.BadStaleness.selector);
        reg.list(address(tsla), address(feed), 31 days, MIN_PX, MAX_PX, address(0xBEEF));
    }

    function test_list_exige_registry_compartido() public {
        // F6: un token cuyo ACCESS_CONTROLLED_REGISTRY difiere no puede listarse en silencio
        _list(address(tsla));
        MockAccessRegistry otherReg = new MockAccessRegistry();
        MockStockToken alien = new MockStockToken("ALIEN", otherReg);
        vm.expectRevert(abi.encodeWithSelector(TokenRegistry.AccessRegistryMismatch.selector, address(otherReg)));
        reg.list(address(alien), address(feed), STALENESS, MIN_PX, MAX_PX, address(0xBEEF));
    }

    function test_no_duplicado_y_solo_owner() public {
        _list(address(tsla));
        vm.expectRevert(TokenRegistry.AlreadyListed.selector);
        _list(address(tsla));

        vm.prank(address(0xBAD));
        vm.expectRevert(TokenRegistry.NotOwner.selector);
        reg.suspend(address(tsla));
    }

    function test_drift_de_beacon_permissionless_y_reapprove_con_commit() public {
        _list(address(tsla));

        vm.prank(address(0xA4014));
        vm.expectRevert(TokenRegistry.NoDrift.selector);
        reg.suspendOnBeaconDrift(address(tsla));

        // El emisor upgradea → cualquiera suspende (C29)
        access.setImplementation(address(0xCAFE));
        vm.prank(address(0xA4014));
        reg.suspendOnBeaconDrift(address(tsla));
        assertFalse(reg.isActive(address(tsla)));

        // F5 (TOCTOU): el owner revisó 0xCAFE pero el emisor vuelve a upgradear antes de la tx
        access.setImplementation(address(0xE711));
        vm.expectRevert(abi.encodeWithSelector(TokenRegistry.ImplMismatch.selector, address(0xE711)));
        reg.reapprove(address(tsla), address(0xCAFE));

        // Reapprove correcto con el commit de la impl vigente
        reg.reapprove(address(tsla), address(0xE711));
        assertTrue(reg.isActive(address(tsla)));
        assertEq(reg.getAsset(address(tsla)).implAtListing, address(0xE711));
    }

    function test_setFeed_como_remediacion() public {
        // F1: feed muerto se sustituye sin re-listar
        _list(address(tsla));
        MockFeed feed2 = new MockFeed(390_00000000);
        reg.setFeed(address(tsla), address(feed2), STALENESS, MIN_PX, MAX_PX);
        assertEq(reg.getAsset(address(tsla)).feed, address(feed2));
    }

    function test_delist() public {
        _list(address(tsla));
        reg.delist(address(tsla));
        assertFalse(reg.isActive(address(tsla)));
        assertFalse(reg.getAsset(address(tsla)).listed);
    }

    function test_resync_access_registry_sigue_al_puntero_vivo() public {
        // F11: si RHJ migra el registry, seguimos el puntero on-chain del token
        _list(address(tsla));
        // (el mock no puede cambiar su puntero, pero el resync debe re-leerlo sin revertir)
        reg.resyncAccessRegistry(address(tsla));
        assertEq(address(reg.accessRegistry()), address(access));
    }

    function test_ownership_dos_pasos() public {
        reg.transferOwnership(address(0xA11CE));
        assertEq(reg.owner(), address(this));
        vm.prank(address(0xA11CE));
        reg.acceptOwnership();
        assertEq(reg.owner(), address(0xA11CE));
    }
}
