// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script, console2} from "forge-std/Script.sol";
import {
    TestnetUSDG,
    TestnetStockImplementationMarker,
    TestnetAccessRegistry,
    TestnetStockToken,
    TestnetPriceFeed,
    TestnetLiquidityVenue,
    TestnetTradeAdapter
} from "../src/testnet/TestnetAssetPack.sol";

/// @title DeployTestnetAssets
/// @notice Despliega activos SIN VALOR para probar NuvemFund en chain 46630 o en un Anvil local
/// configurado con ese chain ID. Este script no puede ejecutarse en Robinhood Chain mainnet.
contract DeployTestnetAssets is Script {
    uint256 internal constant USDG_LIQUIDITY = 250_000_000e6;
    uint256 internal constant STOCK_LIQUIDITY = 2_000_000e18;

    error UnsupportedChain(uint256 chainId);

    function run() external {
        if (block.chainid != 31_337 && block.chainid != 46_630) revert UnsupportedChain(block.chainid);

        uint256 deployerPk = vm.envUint("DEPLOYER_PK");
        address deployer = vm.addr(deployerPk);
        address assetAdmin = vm.envOr("TESTNET_ASSET_ADMIN", deployer);

        vm.startBroadcast(deployerPk);

        TestnetStockImplementationMarker implementation = new TestnetStockImplementationMarker();
        TestnetAccessRegistry access = new TestnetAccessRegistry(address(implementation));
        TestnetUSDG usdg = new TestnetUSDG();

        TestnetStockToken tsla = new TestnetStockToken("NuvemFund Test Tesla", "tTSLA", access);
        TestnetStockToken nvda = new TestnetStockToken("NuvemFund Test Nvidia", "tNVDA", access);
        TestnetStockToken aapl = new TestnetStockToken("NuvemFund Test Apple", "tAAPL", access);
        TestnetStockToken msft = new TestnetStockToken("NuvemFund Test Microsoft", "tMSFT", access);
        TestnetStockToken spy = new TestnetStockToken("NuvemFund Test S&P 500", "tSPY", access);

        TestnetPriceFeed usdgFeed = new TestnetPriceFeed("NuvemFund tUSDG / USD", 1_00000000);
        TestnetPriceFeed tslaFeed = new TestnetPriceFeed("NuvemFund tTSLA / USD", 300_00000000);
        TestnetPriceFeed nvdaFeed = new TestnetPriceFeed("NuvemFund tNVDA / USD", 150_00000000);
        TestnetPriceFeed aaplFeed = new TestnetPriceFeed("NuvemFund tAAPL / USD", 220_00000000);
        TestnetPriceFeed msftFeed = new TestnetPriceFeed("NuvemFund tMSFT / USD", 500_00000000);
        TestnetPriceFeed spyFeed = new TestnetPriceFeed("NuvemFund tSPY / USD", 650_00000000);

        TestnetLiquidityVenue venue = new TestnetLiquidityVenue();
        TestnetTradeAdapter adapter = new TestnetTradeAdapter(venue);
        venue.setAdapter(address(adapter));

        adapter.setAsset(address(usdg), address(usdgFeed));
        adapter.setAsset(address(tsla), address(tslaFeed));
        adapter.setAsset(address(nvda), address(nvdaFeed));
        adapter.setAsset(address(aapl), address(aaplFeed));
        adapter.setAsset(address(msft), address(msftFeed));
        adapter.setAsset(address(spy), address(spyFeed));

        usdg.mint(address(venue), USDG_LIQUIDITY);
        tsla.mint(address(venue), STOCK_LIQUIDITY);
        nvda.mint(address(venue), STOCK_LIQUIDITY);
        aapl.mint(address(venue), STOCK_LIQUIDITY);
        msft.mint(address(venue), STOCK_LIQUIDITY);
        spy.mint(address(venue), STOCK_LIQUIDITY);

        if (assetAdmin != deployer) {
            access.transferOwnership(assetAdmin);
            usdg.transferOwnership(assetAdmin);
            tsla.transferOwnership(assetAdmin);
            nvda.transferOwnership(assetAdmin);
            aapl.transferOwnership(assetAdmin);
            msft.transferOwnership(assetAdmin);
            spy.transferOwnership(assetAdmin);
            usdgFeed.transferOwnership(assetAdmin);
            tslaFeed.transferOwnership(assetAdmin);
            nvdaFeed.transferOwnership(assetAdmin);
            aaplFeed.transferOwnership(assetAdmin);
            msftFeed.transferOwnership(assetAdmin);
            spyFeed.transferOwnership(assetAdmin);
            venue.transferOwnership(assetAdmin);
            adapter.transferOwnership(assetAdmin);
        }

        vm.stopBroadcast();

        console2.log("TESTNET_ASSET_PACK_CHAIN_ID", block.chainid);
        console2.log("TESTNET_IMPLEMENTATION", address(implementation));
        console2.log("TESTNET_ACCESS_REGISTRY", address(access));
        console2.log("TEST_USDG", address(usdg));
        console2.log("TEST_USDG_FEED", address(usdgFeed));
        console2.log("TEST_TSLA", address(tsla));
        console2.log("TEST_TSLA_FEED", address(tslaFeed));
        console2.log("TEST_NVDA", address(nvda));
        console2.log("TEST_NVDA_FEED", address(nvdaFeed));
        console2.log("TEST_AAPL", address(aapl));
        console2.log("TEST_AAPL_FEED", address(aaplFeed));
        console2.log("TEST_MSFT", address(msft));
        console2.log("TEST_MSFT_FEED", address(msftFeed));
        console2.log("TEST_SPY", address(spy));
        console2.log("TEST_SPY_FEED", address(spyFeed));
        console2.log("TEST_LIQUIDITY_VENUE", address(venue));
        console2.log("TEST_TRADE_ADAPTER", address(adapter));
        console2.log("TESTNET_ASSET_ADMIN", assetAdmin);
        console2.log("WARNING: TEST ASSETS HAVE NO VALUE");
    }
}
