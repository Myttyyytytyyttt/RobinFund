// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script, console2} from "forge-std/Script.sol";
import {Fund} from "../src/Fund.sol";
import {TokenRegistry} from "../src/TokenRegistry.sol";
import {AdapterRegistry} from "../src/AdapterRegistry.sol";
import {FundRegistry} from "../src/FundRegistry.sol";
import {IEligibilityGate} from "../src/interfaces/IEligibilityGate.sol";

/// @title CreateFund — despliega un Fund directo y lo registra (SPEC §12, deploy v1)
/// @notice El operador (owner del FundRegistry) despliega un fondo para un manager atestado. El Fund
/// se despliega en una tx directa (su initcode ~38KB < 49KB EIP-3860) — NO desde un contrato. El
/// constructor del Fund exige que el manager sea elegible. Parametrizable por env.
contract CreateFund is Script {
    function run() external {
        TokenRegistry registry = TokenRegistry(vm.envAddress("TOKEN_REGISTRY"));
        AdapterRegistry adapters = AdapterRegistry(vm.envAddress("ADAPTER_REGISTRY"));
        IEligibilityGate gate = IEligibilityGate(vm.envAddress("ELIGIBILITY_GATE"));
        FundRegistry fundRegistry = FundRegistry(vm.envAddress("FUND_REGISTRY"));
        address guardian = vm.envAddress("GUARDIAN");
        address manager = vm.envAddress("FUND_MANAGER");
        address keeper = vm.envAddress("KEEPER");
        address treasury = vm.envAddress("PROTOCOL_TREASURY");

        Fund.Config memory cfg = Fund.Config({
            perfFeeBps: uint16(vm.envOr("PERF_FEE_BPS", uint256(2000))),
            feeMinBps: uint16(vm.envOr("FEE_MIN_BPS", uint256(0))),
            feeMaxBps: uint16(vm.envOr("FEE_MAX_BPS", uint256(200))),
            managerEntryShareBps: uint16(vm.envOr("MGR_ENTRY_BPS", uint256(5000))),
            kFactor: uint16(vm.envOr("K_FACTOR", uint256(25))),
            period: uint32(vm.envOr("PERIOD", uint256(30 days))),
            withdrawCooldown: uint32(vm.envOr("COOLDOWN", uint256(24 hours)))
        });

        vm.startBroadcast();
        Fund fund = new Fund(
            registry, gate, adapters, guardian, manager, keeper, treasury, cfg,
            vm.envString("FUND_NAME"), vm.envString("FUND_SYMBOL")
        );
        fundRegistry.register(address(fund), manager);
        vm.stopBroadcast();

        console2.log("Fund creado y registrado:", address(fund), "manager", manager);
    }
}
