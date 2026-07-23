// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script, console2} from "forge-std/Script.sol";
import {AdapterRegistry} from "../src/AdapterRegistry.sol";
import {AgentRegistry} from "../src/agents/AgentRegistry.sol";
import {UniswapApiAdapter} from "../src/adapters/UniswapApiAdapter.sol";
import {DevnetApprovalProxy} from "../src/dev/DevnetApprovalProxy.sol";

/// @title DeployAgents
/// @notice Deploys the shared Nuvem Agents contracts. The adapter is registered while the
/// deployer still owns AdapterRegistry; governed deployments must queue the equivalent add call.
contract DeployAgents is Script {
    function run() external {
        uint256 deployerPk = vm.envUint("DEPLOYER_PK");
        address worldVerifier = vm.envAddress("WORLD_VERIFIER");
        address approvalProxy = vm.envAddress("UNISWAP_APPROVAL_PROXY");
        address universalRouter = vm.envAddress("UNISWAP_UNIVERSAL_ROUTER");
        bool localMock = block.chainid == 31337 && vm.envOr("DEVNET_MOCK_APPROVAL_PROXY", false);
        AdapterRegistry adapters = AdapterRegistry(vm.envAddress("ADAPTER_REGISTRY"));

        vm.startBroadcast(deployerPk);
        if (localMock) {
            approvalProxy = address(new DevnetApprovalProxy());
            universalRouter = approvalProxy;
        }
        AgentRegistry registry = new AgentRegistry(worldVerifier);
        UniswapApiAdapter apiAdapter = new UniswapApiAdapter(approvalProxy, universalRouter);
        uint256 adapterId = adapters.add(address(apiAdapter));
        vm.stopBroadcast();

        console2.log("AGENT_REGISTRY", address(registry));
        console2.log("UNISWAP_API_ADAPTER", address(apiAdapter));
        console2.log("UNISWAP_API_ADAPTER_ID", adapterId);
        console2.log("WORLD_VERIFIER", worldVerifier);
        console2.log("UNISWAP_APPROVAL_PROXY", approvalProxy);
        console2.log("UNISWAP_UNIVERSAL_ROUTER", universalRouter);
        console2.log("DEVNET_MOCK_APPROVAL_PROXY", localMock);
    }
}
