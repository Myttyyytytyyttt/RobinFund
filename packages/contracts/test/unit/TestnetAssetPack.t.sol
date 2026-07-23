// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {TokenRegistry} from "../../src/TokenRegistry.sol";
import {
    TestnetOwned,
    TestnetUSDG,
    TestnetStockImplementationMarker,
    TestnetAccessRegistry,
    TestnetStockToken,
    TestnetPriceFeed,
    TestnetLiquidityVenue,
    TestnetTradeAdapter
} from "../../src/testnet/TestnetAssetPack.sol";

contract TestnetAssetPackTest is Test {
    TestnetStockImplementationMarker internal implementation;
    TestnetAccessRegistry internal access;
    TestnetUSDG internal usdg;
    TestnetStockToken internal stock;
    TestnetPriceFeed internal usdgFeed;
    TestnetPriceFeed internal stockFeed;
    TestnetLiquidityVenue internal venue;
    TestnetTradeAdapter internal adapter;

    address internal alice = address(0xA11CE);
    address internal bob = address(0xB0B);

    function setUp() public {
        vm.warp(100 days);
        implementation = new TestnetStockImplementationMarker();
        access = new TestnetAccessRegistry(address(implementation));
        usdg = new TestnetUSDG();
        stock = new TestnetStockToken("NuvemFund Test Tesla", "tTSLA", access);
        usdgFeed = new TestnetPriceFeed("tUSDG / USD", 1_00000000);
        stockFeed = new TestnetPriceFeed("tTSLA / USD", 100_00000000);
        venue = new TestnetLiquidityVenue();
        adapter = new TestnetTradeAdapter(venue);

        venue.setAdapter(address(adapter));
        adapter.setAsset(address(usdg), address(usdgFeed));
        adapter.setAsset(address(stock), address(stockFeed));
        usdg.mint(address(venue), 10_000_000e6);
        stock.mint(address(venue), 100_000e18);
    }

    function test_pack_no_puede_desplegarse_en_mainnet_4663() public {
        vm.chainId(4663);

        vm.expectRevert(TestnetOwned.MainnetForbidden.selector);
        new TestnetUSDG();

        vm.expectRevert(TestnetStockImplementationMarker.MainnetForbidden.selector);
        new TestnetStockImplementationMarker();
    }

    function test_usdg_tiene_6_decimales_y_faucet_diario() public {
        assertEq(usdg.decimals(), 6);

        vm.prank(alice);
        uint256 amount = usdg.faucet();
        assertEq(amount, 100_000e6);
        assertEq(usdg.balanceOf(alice), amount);

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(TestnetUSDG.FaucetCooldown.selector, block.timestamp + 1 days));
        usdg.faucet();

        vm.warp(block.timestamp + 1 days);
        vm.prank(alice);
        usdg.faucet();
        assertEq(usdg.balanceOf(alice), 200_000e6);
    }

    function test_stock_reproduce_blacklist_y_pausas() public {
        stock.mint(alice, 10e18);

        access.setBlocked(bob, true);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(TestnetStockToken.AddressBlocked.selector, bob));
        stock.transfer(bob, 1e18);

        access.setBlocked(bob, false);
        access.setPaused(true);
        vm.prank(alice);
        vm.expectRevert(TestnetStockToken.TransfersPaused.selector);
        stock.transfer(bob, 1e18);

        access.setPaused(false);
        stock.setTokenPaused(true);
        vm.prank(alice);
        vm.expectRevert(TestnetStockToken.TransfersPaused.selector);
        stock.transfer(bob, 1e18);

        stock.setTokenPaused(false);
        vm.prank(alice);
        stock.transfer(bob, 1e18);
        assertEq(stock.balanceOf(bob), 1e18);
    }

    function test_stock_erc8056_programa_y_aplica_multiplier_ui() public {
        stock.mint(alice, 10e18);
        uint256 effective = block.timestamp + 1 days;
        stock.scheduleUiMultiplier(2e18, effective);

        vm.expectRevert(TestnetStockToken.MultiplierNotReady.selector);
        stock.applyUiMultiplier();

        vm.warp(effective);
        stock.applyUiMultiplier();
        assertEq(stock.uiMultiplier(), 2e18);
        assertEq(stock.balanceOfUI(alice), 20e18);
        assertEq(stock.totalSupplyUI(), stock.totalSupply() * 2);
    }

    function test_feed_es_8_decimales_y_poke_refresca_la_ronda() public {
        assertEq(stockFeed.decimals(), 8);
        (uint80 firstRound, int256 firstAnswer,, uint256 firstUpdated,) = stockFeed.latestRoundData();
        assertEq(firstAnswer, 100_00000000);

        vm.warp(block.timestamp + 2 days);
        stockFeed.poke();
        (uint80 secondRound, int256 secondAnswer,, uint256 secondUpdated,) = stockFeed.latestRoundData();
        assertEq(secondRound, firstRound + 1);
        assertEq(secondAnswer, firstAnswer);
        assertEq(secondUpdated, block.timestamp);
        assertGt(secondUpdated, firstUpdated);

        stockFeed.setAnswerAt(90_00000000, block.timestamp - 1 days);
        (,,, uint256 staleUpdated,) = stockFeed.latestRoundData();
        assertEq(staleUpdated, block.timestamp - 1 days);
    }

    function test_adapter_compra_y_vende_a_precio_de_feed_sin_residuo() public {
        usdg.mint(address(adapter), 1_000e6);
        adapter.swap(address(usdg), address(stock), 1_000e6, alice, "");

        assertEq(stock.balanceOf(alice), 10e18);
        assertEq(usdg.balanceOf(address(adapter)), 0);
        assertEq(stock.balanceOf(address(adapter)), 0);

        vm.prank(alice);
        stock.transfer(address(adapter), 5e18);
        adapter.swap(address(stock), address(usdg), 5e18, alice, "");

        assertEq(usdg.balanceOf(alice), 500e6);
        assertEq(usdg.balanceOf(address(adapter)), 0);
        assertEq(stock.balanceOf(address(adapter)), 0);
    }

    function test_adapter_valida_payload_del_controller_agentico() public view {
        bytes memory plan = abi.encode(9e18, uint48(block.timestamp + 5 minutes));
        assertTrue(adapter.validateExecution(address(usdg), address(stock), 1_000e6, address(this), 9e18, plan));
        assertFalse(adapter.validateExecution(address(usdg), address(stock), 1_000e6, address(this), 8e18, plan));
        assertFalse(
            adapter.validateExecution(
                address(usdg), address(stock), 1_000e6, address(this), 9e18,
                abi.encode(9e18, uint48(block.timestamp - 1))
            )
        );
        assertFalse(adapter.validateExecution(address(usdg), address(stock), 1_000e6, address(this), 9e18, ""));
    }

    function test_venue_solo_paga_al_adapter_y_queda_bloqueado() public {
        vm.prank(alice);
        vm.expectRevert(TestnetLiquidityVenue.NotAdapter.selector);
        venue.pay(address(usdg), alice, 1e6);

        vm.expectRevert(TestnetLiquidityVenue.AdapterLocked.selector);
        venue.setAdapter(bob);
    }

    function test_pack_se_lista_y_detecta_drift_del_beacon() public {
        TokenRegistry registry = new TokenRegistry(address(usdg));
        registry.setUsdgFeed(address(usdgFeed), 90_000, 90_000000, 110_000000);
        registry.list(address(stock), address(stockFeed), 90_000, 1_00000000, 100_000_00000000, address(implementation));

        assertTrue(registry.isActive(address(stock)));
        assertEq(address(registry.accessRegistry()), address(access));

        TestnetStockImplementationMarker upgraded = new TestnetStockImplementationMarker();
        access.setImplementation(address(upgraded));
        vm.prank(alice);
        registry.suspendOnBeaconDrift(address(stock));
        assertFalse(registry.isActive(address(stock)));
    }
}
