// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script, console2} from "forge-std/Script.sol";
import {AgentRegistry} from "../src/agents/AgentRegistry.sol";

/// @title DeployAgentRegistryTestnet
/// @notice Public-testnet deployment intentionally reuses adapter id 0 from the existing
/// TestnetAssetPack. It does not label a deterministic test venue as Uniswap.
contract DeployAgentRegistryTestnet is Script {
    error UnsupportedChain(uint256 chainId);

    function run() external {
        if (block.chainid != 46_630) revert UnsupportedChain(block.chainid);

        uint256 deployerPk = vm.envUint("DEPLOYER_PK");
        address worldVerifier = vm.envAddress("WORLD_VERIFIER");

        vm.startBroadcast(deployerPk);
        AgentRegistry registry = new AgentRegistry(worldVerifier);
        vm.stopBroadcast();

        console2.log("AGENT_REGISTRY", address(registry));
        console2.log("WORLD_VERIFIER", worldVerifier);
        console2.log("TESTNET_TRADE_ADAPTER_ID", uint256(0));
    }
}
