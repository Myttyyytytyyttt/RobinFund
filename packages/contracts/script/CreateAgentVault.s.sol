// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script, console2} from "forge-std/Script.sol";
import {Fund} from "../src/Fund.sol";
import {FundRegistry} from "../src/FundRegistry.sol";
import {TokenRegistry} from "../src/TokenRegistry.sol";
import {AdapterRegistry} from "../src/AdapterRegistry.sol";
import {IEligibilityGate} from "../src/interfaces/IEligibilityGate.sol";
import {AgentRegistry} from "../src/agents/AgentRegistry.sol";
import {AgentVaultController} from "../src/agents/AgentVaultController.sol";

/// @title CreateAgentVault
/// @notice Operator step for an already registered agent. The sponsor completes setController,
/// bindFund and stake from their own wallet; neither key nor authority is delegated to the operator.
contract CreateAgentVault is Script {
    function run() external {
        uint256 deployerPk = vm.envUint("DEPLOYER_PK");
        address sponsor = vm.envAddress("AGENT_SPONSOR");
        bytes32 agentId = vm.envBytes32("AGENT_ID");
        AgentRegistry agentRegistry = AgentRegistry(vm.envAddress("AGENT_REGISTRY"));
        TokenRegistry registry = TokenRegistry(vm.envAddress("TOKEN_REGISTRY"));
        AdapterRegistry adapters = AdapterRegistry(vm.envAddress("ADAPTER_REGISTRY"));
        uint256 adapterId = vm.envUint("UNISWAP_API_ADAPTER_ID");
        address adapter = vm.envAddress("UNISWAP_API_ADAPTER");
        address[] memory assets = vm.envAddress("AGENT_ASSETS", ",");
        _sort(assets);

        AgentVaultController.Policy memory policy = AgentVaultController.Policy({
            maxTradeBps: uint16(vm.envOr("MAX_TRADE_BPS", uint256(1000))),
            maxConcentrationBps: uint16(vm.envOr("MAX_CONCENTRATION_BPS", uint256(3500))),
            dailyTurnoverBps: uint16(vm.envOr("DAILY_TURNOVER_BPS", uint256(5000))),
            maxSlippageBps: uint16(vm.envOr("MAX_SLIPPAGE_BPS", uint256(75))),
            maxTradesPerDay: uint16(vm.envOr("MAX_TRADES_PER_DAY", uint256(24))),
            minTradeInterval: uint32(vm.envOr("MIN_TRADE_INTERVAL", uint256(5 minutes))),
            maxIntentLifetime: uint32(vm.envOr("MAX_INTENT_LIFETIME", uint256(5 minutes)))
        });
        Fund.Config memory cfg = Fund.Config({
            perfFeeBps: uint16(vm.envOr("PERF_FEE_BPS", uint256(2000))),
            feeMinBps: uint16(vm.envOr("FEE_MIN_BPS", uint256(0))),
            feeMaxBps: uint16(vm.envOr("FEE_MAX_BPS", uint256(200))),
            managerEntryShareBps: uint16(vm.envOr("MGR_ENTRY_BPS", uint256(5000))),
            kFactor: uint16(vm.envOr("K_FACTOR", uint256(25))),
            period: uint32(vm.envOr("PERIOD", uint256(30 days))),
            withdrawCooldown: uint32(vm.envOr("COOLDOWN", uint256(24 hours)))
        });

        vm.startBroadcast(deployerPk);
        AgentVaultController controller = new AgentVaultController(
            agentRegistry, registry, agentId, sponsor, adapterId, adapter, policy, assets
        );
        Fund fund = new Fund(
            registry,
            IEligibilityGate(vm.envAddress("ELIGIBILITY_GATE")),
            adapters,
            vm.envAddress("GUARDIAN"),
            address(controller),
            vm.envAddress("KEEPER"),
            vm.envAddress("PROTOCOL_TREASURY"),
            cfg,
            vm.envString("FUND_NAME"),
            vm.envString("FUND_SYMBOL")
        );
        FundRegistry(vm.envAddress("FUND_REGISTRY")).register(address(fund), address(controller));
        vm.stopBroadcast();

        console2.log("AGENT_VAULT_CONTROLLER", address(controller));
        console2.log("AGENT_FUND", address(fund));
        console2.log("AGENT_STAKE_ESCROW", address(fund.stakeEscrow()));
        console2.log("AGENT_POLICY_HASH", uint256(controller.policyHash()));
    }

    function _sort(address[] memory values) private pure {
        for (uint256 i = 1; i < values.length; ++i) {
            address value = values[i];
            uint256 j = i;
            while (j != 0 && values[j - 1] > value) {
                values[j] = values[j - 1];
                unchecked { --j; }
            }
            values[j] = value;
        }
    }
}
