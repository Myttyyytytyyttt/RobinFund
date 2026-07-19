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

    function setUp() public {
        access = new MockAccessRegistry();
        tsla = new MockStockToken("TSLA", access);
        usdg = new MockUSDG();
        feed = new MockFeed(380_00000000);
        reg = new TokenRegistry(address(usdg));
    }

    function test_list_captura_beacon_e_impl() public {
        reg.list(address(tsla), address(feed), 90000);
        TokenRegistry.Asset memory a = reg.getAsset(address(tsla));
        assertTrue(a.listed);
        assertEq(a.beacon, address(access), "beacon = ACCESS_CONTROLLED_REGISTRY del token");
        assertEq(a.implAtListing, address(0xBEEF));
        assertEq(address(reg.accessRegistry()), address(access), "primer listado fija el access registry");
        assertTrue(reg.isActive(address(tsla)));
    }

    function test_list_rechaza_feed_invalido() public {
        MockFeed bad = new MockFeed(0);
        vm.expectRevert(TokenRegistry.BadFeed.selector);
        reg.list(address(tsla), address(bad), 90000);
    }

    function test_list_solo_owner_y_no_duplicado() public {
        reg.list(address(tsla), address(feed), 90000);
        vm.expectRevert(TokenRegistry.AlreadyListed.selector);
        reg.list(address(tsla), address(feed), 90000);

        vm.prank(address(0xBAD));
        vm.expectRevert(TokenRegistry.NotOwner.selector);
        reg.suspend(address(tsla));
    }

    function test_suspension_por_drift_de_beacon_es_permissionless() public {
        reg.list(address(tsla), address(feed), 90000);

        // Sin drift: revierte
        vm.prank(address(0xA4014));
        vm.expectRevert(TokenRegistry.NoDrift.selector);
        reg.suspendOnBeaconDrift(address(tsla));

        // El emisor upgradea el beacon → cualquiera suspende (C29)
        access.setImplementation(address(0xCAFE));
        vm.prank(address(0xA4014));
        reg.suspendOnBeaconDrift(address(tsla));
        assertFalse(reg.isActive(address(tsla)));

        // Re-aprobación del owner captura la nueva impl
        reg.reapprove(address(tsla));
        assertTrue(reg.isActive(address(tsla)));
        assertEq(reg.getAsset(address(tsla)).implAtListing, address(0xCAFE));
    }

    function test_ownership_dos_pasos() public {
        reg.transferOwnership(address(0xA11CE));
        assertEq(reg.owner(), address(this), "sigue siendo el owner hasta aceptar");
        vm.prank(address(0xA11CE));
        reg.acceptOwnership();
        assertEq(reg.owner(), address(0xA11CE));
    }
}
