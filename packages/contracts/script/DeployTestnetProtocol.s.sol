// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script, console2} from "forge-std/Script.sol";
import {TokenRegistry} from "../src/TokenRegistry.sol";
import {AdapterRegistry} from "../src/AdapterRegistry.sol";
import {OpenEligibilityGate} from "../src/OpenEligibilityGate.sol";
import {Guardian} from "../src/Guardian.sol";
import {FundRegistry} from "../src/FundRegistry.sol";

/// @title DeployTestnetProtocol
/// @notice Wiring explícito del protocolo permissionless sobre TestnetAssetPack. AddressBook.sol no
/// participa: las direcciones de test se inyectan por entorno y nunca contaminan el deploy mainnet.
contract DeployTestnetProtocol is Script {
    uint48 internal constant STALENESS = 90_000;

    error UnsupportedChain(uint256 chainId);

    function run() external {
        if (block.chainid != 31_337 && block.chainid != 46_630) revert UnsupportedChain(block.chainid);

        uint256 deployerPk = vm.envUint("DEPLOYER_PK");
        address deployer = vm.addr(deployerPk);
        address multisig = vm.envOr("GUARDIAN_MULTISIG", deployer);
        uint256 guardianDelay = vm.envOr("GUARDIAN_DELAY", uint256(2 days));

        address usdg = vm.envAddress("TEST_USDG");
        address implementation = vm.envAddress("TESTNET_IMPLEMENTATION");
        address testAdapter = vm.envAddress("TEST_TRADE_ADAPTER");

        vm.startBroadcast(deployerPk);

        TokenRegistry registry = new TokenRegistry(usdg);
        AdapterRegistry adapters = new AdapterRegistry();
        OpenEligibilityGate gate = new OpenEligibilityGate();
        Guardian guardian = new Guardian(multisig, guardianDelay);
        FundRegistry fundRegistry = new FundRegistry();

        uint256 adapterId = adapters.add(testAdapter);
        registry.setUsdgFeed(vm.envAddress("TEST_USDG_FEED"), STALENESS, 90_000000, 110_000000);
        _list(registry, "TEST_TSLA", "TEST_TSLA_FEED", implementation);
        _list(registry, "TEST_NVDA", "TEST_NVDA_FEED", implementation);
        _list(registry, "TEST_AAPL", "TEST_AAPL_FEED", implementation);
        _list(registry, "TEST_MSFT", "TEST_MSFT_FEED", implementation);
        _list(registry, "TEST_SPY", "TEST_SPY_FEED", implementation);

        registry.transferOwnership(address(guardian));
        adapters.transferOwnership(address(guardian));

        vm.stopBroadcast();

        console2.log("TESTNET_PROTOCOL_CHAIN_ID", block.chainid);
        console2.log("TOKEN_REGISTRY", address(registry));
        console2.log("ADAPTER_REGISTRY", address(adapters));
        console2.log("OPEN_ELIGIBILITY_GATE", address(gate));
        console2.log("GUARDIAN", address(guardian));
        console2.log("FUND_REGISTRY", address(fundRegistry));
        console2.log("TEST_TRADE_ADAPTER_ID", adapterId);
        console2.log("FUND_REGISTRY_OWNER", deployer);
    }

    function _list(TokenRegistry registry, string memory tokenKey, string memory feedKey, address implementation)
        internal
    {
        registry.list(
            vm.envAddress(tokenKey), vm.envAddress(feedKey), STALENESS, 1_00000000, 100_000_00000000, implementation
        );
    }
}
