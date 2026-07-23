// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script, console2} from "forge-std/Script.sol";
import {AdapterRegistry} from "../src/AdapterRegistry.sol";
import {
    TestnetUSDG,
    TestnetStockToken,
    TestnetLiquidityVenue,
    TestnetTradeAdapter
} from "../src/testnet/TestnetAssetPack.sol";

/// @title DeployAgentTestnetAdapter
/// @notice Extiende el asset pack publico con un venue sin valor cuyo adapter
/// implementa la validacion previa exigida por AgentVaultController.
contract DeployAgentTestnetAdapter is Script {
    address internal constant USDG = 0x336c508083E2AFe17c594A8EF5B8542eFcf672D5;
    address internal constant TSLA = 0x3f1a8F0A7D944875e3350B0c78D56d22990A6E2F;
    address internal constant NVDA = 0x3b334d58c329F7A98CA3c11a09E45AE3352263Ae;
    address internal constant AAPL = 0x6FD0D905aF9841A2A268Ab4784EfE24575a48d1c;
    address internal constant MSFT = 0x5CC41B676E626C29FA685c1e9057d0264d3c6F05;
    address internal constant SPY = 0x2B41f3C8b61e7188a2c7dbF494ebf6D0beacEd22;

    address internal constant USDG_FEED = 0xf9F57Ca222bA95B0C9F081Cdf657eAF6C2aDa255;
    address internal constant TSLA_FEED = 0xE34BdC7e618C38cBdB794eFCa53eeEC22cAFF017;
    address internal constant NVDA_FEED = 0xf3fAaA261127Ec23AAd71C44ea0b54E6515485ef;
    address internal constant AAPL_FEED = 0x9769e666F0557B50417FE9bdF8038f40e41FAA22;
    address internal constant MSFT_FEED = 0xE5d3EA4066Cd7871f1920D9Cdad1f77990882A84;
    address internal constant SPY_FEED = 0x249363c9fb7fa1E1b45ac270598486FF292a1ded;

    AdapterRegistry internal constant ADAPTER_REGISTRY =
        AdapterRegistry(0xcA3Ed32482e64c62CC50C72a01493eA5B33a689e);

    uint256 internal constant USDG_LIQUIDITY = 50_000_000e6;
    uint256 internal constant STOCK_LIQUIDITY = 250_000e18;

    error UnsupportedChain(uint256 chainId);
    error BroadcastNotAllowed();
    error UnexpectedRegistryState();

    function run() external {
        if (block.chainid != 46_630) revert UnsupportedChain(block.chainid);
        if (!vm.envOr("ALLOW_TESTNET_BROADCAST", false)) revert BroadcastNotAllowed();

        uint256 deployerPk = vm.envUint("DEPLOYER_PK");
        address deployer = vm.addr(deployerPk);
        if (ADAPTER_REGISTRY.owner() != deployer || ADAPTER_REGISTRY.count() != 1) {
            revert UnexpectedRegistryState();
        }

        vm.startBroadcast(deployerPk);
        TestnetLiquidityVenue venue = new TestnetLiquidityVenue();
        TestnetTradeAdapter adapter = new TestnetTradeAdapter(venue);
        venue.setAdapter(address(adapter));

        adapter.setAsset(USDG, USDG_FEED);
        adapter.setAsset(TSLA, TSLA_FEED);
        adapter.setAsset(NVDA, NVDA_FEED);
        adapter.setAsset(AAPL, AAPL_FEED);
        adapter.setAsset(MSFT, MSFT_FEED);
        adapter.setAsset(SPY, SPY_FEED);

        TestnetUSDG(USDG).mint(address(venue), USDG_LIQUIDITY);
        TestnetStockToken(TSLA).mint(address(venue), STOCK_LIQUIDITY);
        TestnetStockToken(NVDA).mint(address(venue), STOCK_LIQUIDITY);
        TestnetStockToken(AAPL).mint(address(venue), STOCK_LIQUIDITY);
        TestnetStockToken(MSFT).mint(address(venue), STOCK_LIQUIDITY);
        TestnetStockToken(SPY).mint(address(venue), STOCK_LIQUIDITY);

        uint256 adapterId = ADAPTER_REGISTRY.add(address(adapter));
        vm.stopBroadcast();

        console2.log("AGENT_TESTNET_ADAPTER_ID", adapterId);
        console2.log("AGENT_TESTNET_VENUE", address(venue));
        console2.log("AGENT_TESTNET_ADAPTER", address(adapter));
        console2.log("WARNING: TEST ASSETS AND VENUE HAVE NO VALUE");
    }
}
