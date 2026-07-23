// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {AgentRegistry} from "../../../src/agents/AgentRegistry.sol";
import {AgentVaultController} from "../../../src/agents/AgentVaultController.sol";
import {UniswapApiAdapter} from "../../../src/adapters/UniswapApiAdapter.sol";
import {Fund} from "../../../src/Fund.sol";
import {TokenRegistry} from "../../../src/TokenRegistry.sol";
import {AdapterRegistry} from "../../../src/AdapterRegistry.sol";
import {IEligibilityGate} from "../../../src/interfaces/IEligibilityGate.sol";
import {IERC20} from "../../../src/interfaces/IERC20.sol";
import {
    MockAccessRegistry,
    MockStockToken,
    MockUSDG,
    MockFeed,
    MockGate
} from "../../mocks/Mocks.sol";

interface IMintForAgentTest {
    function mint(address to, uint256 amount) external;
}

contract AgentApprovalProxyMock {
    address public sink = address(0xDEC0DE);

    function execute(
        address router,
        address tokenIn,
        uint256 amountIn,
        bytes calldata route,
        bytes[] calldata,
        uint256 deadline
    ) external {
        require(block.timestamp <= deadline, "expired");
        require(router == address(this), "wrong router");
        (address tokenOut, address recipient, uint256 amountOut) =
            abi.decode(route, (address, address, uint256));
        IERC20(tokenIn).transferFrom(msg.sender, sink, amountIn);
        IMintForAgentTest(tokenOut).mint(recipient, amountOut);
    }
}

contract AgentVaultControllerTest is Test {
    uint256 internal constant WORLD_PK = 0xA11CE;
    uint256 internal constant AGENT_PK = 0xA6E17;
    uint256 internal constant NEXT_AGENT_PK = 0xB0B17;
    bytes32 internal constant AGENT_ID = keccak256("atlas.nuvem.agent");
    uint48 internal constant STALENESS = 30 days;

    address internal sponsor = address(0x5A0A50);
    address internal keeper = address(0x6E6E);
    address internal treasury = address(0x7EA5);

    MockAccessRegistry internal access;
    MockStockToken internal tsla;
    MockUSDG internal usdg;
    MockFeed internal tslaFeed;
    MockFeed internal usdgFeed;
    MockGate internal gate;
    TokenRegistry internal tokenRegistry;
    AdapterRegistry internal adapters;
    AgentApprovalProxyMock internal proxy;
    UniswapApiAdapter internal apiAdapter;
    AgentRegistry internal agentRegistry;
    AgentVaultController internal controller;
    Fund internal fund;
    uint256 internal adapterId;

    function setUp() public {
        vm.warp(1_800_000_000);
        access = new MockAccessRegistry();
        tsla = new MockStockToken("TSLA", access);
        usdg = new MockUSDG();
        tslaFeed = new MockFeed(100_00000000);
        usdgFeed = new MockFeed(1_00000000);
        gate = new MockGate();

        tokenRegistry = new TokenRegistry(address(usdg));
        tokenRegistry.list(
            address(tsla), address(tslaFeed), STALENESS, 50_00000000, 200_00000000, address(0xBEEF)
        );
        tokenRegistry.setUsdgFeed(address(usdgFeed), STALENESS, 90_000000, 110_000000);

        proxy = new AgentApprovalProxyMock();
        apiAdapter = new UniswapApiAdapter(address(proxy), address(proxy));
        adapters = new AdapterRegistry();
        adapterId = adapters.add(address(apiAdapter));

        agentRegistry = new AgentRegistry(vm.addr(WORLD_PK));
        vm.prank(sponsor);
        agentRegistry.register(AGENT_ID, vm.addr(AGENT_PK), "ipfs://atlas");
        _activateAgent(vm.addr(AGENT_PK));

        address[] memory assets = new address[](1);
        assets[0] = address(tsla);
        controller = new AgentVaultController(
            agentRegistry,
            tokenRegistry,
            AGENT_ID,
            sponsor,
            adapterId,
            address(apiAdapter),
            _defaultPolicy(),
            assets
        );
        vm.prank(sponsor);
        agentRegistry.setController(AGENT_ID, address(controller), true);

        fund = new Fund(
            tokenRegistry,
            IEligibilityGate(address(gate)),
            adapters,
            address(0x6DAD),
            address(controller),
            keeper,
            treasury,
            Fund.Config({
                perfFeeBps: 2000,
                feeMinBps: 0,
                feeMaxBps: 0,
                managerEntryShareBps: 5000,
                kFactor: 25,
                period: 30 days,
                withdrawCooldown: 24 hours
            }),
            "Nuvem Agent Vault",
            "NAV-AI"
        );
        vm.prank(sponsor);
        controller.bindFund(address(fund));

        usdg.mint(address(fund), 10_000_000000);
        usdg.mint(sponsor, 10_000_000000);
        vm.startPrank(sponsor);
        usdg.approve(address(fund.stakeEscrow()), 10_000_000000);
        fund.stakeEscrow().addStake(10_000_000000);
        vm.stopPrank();
    }

    function test_relayer_sin_privilegios_ejecuta_intent_valida() public {
        (AgentVaultController.TradeIntentV1 memory intent, bytes memory data) =
            _intent(1_000_000000, 10e18, 9.95e18);
        address relayer = address(0xB07);
        bytes memory signature = _sign(AGENT_PK, controller.hashTradeIntent(intent));
        vm.prank(relayer);
        controller.executeTrade(intent, data, signature);

        assertEq(tsla.balanceOf(address(fund)), 10e18);
        assertEq(controller.nextNonce(), 1);
        assertEq(controller.tradesToday(), 1);
        assertEq(controller.turnoverTodayWad(), 1000e18);
    }

    function test_firma_falsa_controller_chain_equivocados_y_replay() public {
        (AgentVaultController.TradeIntentV1 memory intent, bytes memory data) =
            _intent(1_000_000000, 10e18, 9.95e18);
        _expectTradeRevert(AgentVaultController.InvalidSignature.selector, intent, data, NEXT_AGENT_PK);

        address[] memory assets = new address[](1);
        assets[0] = address(tsla);
        AgentVaultController other = new AgentVaultController(
            agentRegistry,
            tokenRegistry,
            AGENT_ID,
            sponsor,
            adapterId,
            address(apiAdapter),
            _defaultPolicy(),
            assets
        );
        bytes memory wrongControllerSig = _sign(AGENT_PK, other.hashTradeIntent(intent));
        vm.expectRevert(AgentVaultController.InvalidSignature.selector);
        controller.executeTrade(intent, data, wrongControllerSig);

        bytes memory valid = _sign(AGENT_PK, controller.hashTradeIntent(intent));
        uint256 originalChain = block.chainid;
        vm.chainId(46_630);
        vm.expectRevert(AgentVaultController.InvalidSignature.selector);
        controller.executeTrade(intent, data, valid);
        vm.chainId(originalChain);

        controller.executeTrade(intent, data, _sign(AGENT_PK, controller.hashTradeIntent(intent)));
        _expectTradeRevert(AgentVaultController.InvalidNonce.selector, intent, data, AGENT_PK);
    }

    function test_intent_expirada_policy_vieja_y_execution_adulterada() public {
        (AgentVaultController.TradeIntentV1 memory intent, bytes memory data) =
            _intent(1_000_000000, 10e18, 9.95e18);
        intent.deadline = uint48(block.timestamp - 1);
        _expectTradeRevert(AgentVaultController.IntentExpired.selector, intent, data, AGENT_PK);

        (intent, data) = _intent(1_000_000000, 10e18, 9.95e18);
        bytes memory tampered =
            _adapterData(address(tsla), 1_000_000000, 9.9e18, 9.9e18, address(fund));
        _expectTradeRevert(AgentVaultController.ExecutionMismatch.selector, intent, tampered, AGENT_PK);

        AgentVaultController.Policy memory changed = _defaultPolicy();
        changed.maxTradesPerDay = 12;
        address[] memory assets = _assets();
        vm.prank(sponsor);
        controller.proposePolicy(changed, assets);
        vm.warp(controller.pendingPolicyEta());
        controller.activatePolicy();
        uint256 nowTs = vm.getBlockTimestamp();
        intent.validAfter = uint48(nowTs);
        intent.deadline = uint48(nowTs + 5 minutes);
        _expectTradeRevert(AgentVaultController.PolicyMismatch.selector, intent, data, AGENT_PK);
    }

    function test_world_pause_y_rotacion_cortan_clave_vieja() public {
        (AgentVaultController.TradeIntentV1 memory intent, bytes memory data) =
            _intent(1_000_000000, 10e18, 9.95e18);
        vm.prank(sponsor);
        agentRegistry.pause(AGENT_ID);
        _expectTradeRevert(AgentVaultController.AgentInactive.selector, intent, data, AGENT_PK);

        vm.prank(sponsor);
        agentRegistry.resume(AGENT_ID);
        _activateAgent(vm.addr(AGENT_PK));
        vm.prank(sponsor);
        agentRegistry.rotateSigner(AGENT_ID, vm.addr(NEXT_AGENT_PK));
        _activateAgent(vm.addr(NEXT_AGENT_PK));

        _expectTradeRevert(AgentVaultController.InvalidSignature.selector, intent, data, AGENT_PK);
        controller.executeTrade(intent, data, _sign(NEXT_AGENT_PK, controller.hashTradeIntent(intent)));
    }

    function test_asset_prohibido_y_trade_maximo_revierten() public {
        MockStockToken nvda = new MockStockToken("NVDA", access);
        tokenRegistry.list(
            address(nvda), address(tslaFeed), STALENESS, 50_00000000, 200_00000000, address(0xBEEF)
        );
        (AgentVaultController.TradeIntentV1 memory forbidden, bytes memory forbiddenData) =
            _intentFor(address(nvda), 500_000000, 5e18, 4.95e18);
        _expectTradeRevert(AgentVaultController.BadAssets.selector, forbidden, forbiddenData, AGENT_PK);

        (AgentVaultController.TradeIntentV1 memory tooLarge, bytes memory tooLargeData) =
            _intent(1_001_000000, 10.01e18, 9.95e18);
        _expectTradeRevert(AgentVaultController.TradeTooLarge.selector, tooLarge, tooLargeData, AGENT_PK);
    }

    function test_concentracion_turnover_frecuencia_y_slippage() public {
        AgentVaultController.Policy memory tight = _defaultPolicy();
        tight.maxConcentrationBps = 1000;
        address[] memory assets = _assets();
        vm.prank(sponsor);
        controller.proposePolicy(tight, assets);
        vm.warp(controller.pendingPolicyEta());
        controller.activatePolicy();

        (AgentVaultController.TradeIntentV1 memory first, bytes memory firstData) =
            _intent(1_000_000000, 10e18, 9.95e18);
        controller.executeTrade(first, firstData, _sign(AGENT_PK, controller.hashTradeIntent(first)));
        vm.warp(vm.getBlockTimestamp() + 5 minutes);
        (AgentVaultController.TradeIntentV1 memory concentrated, bytes memory concentratedData) =
            _intent(500_000000, 5e18, 4.95e18);
        _expectTradeRevert(
            AgentVaultController.ConcentrationExceeded.selector, concentrated, concentratedData, AGENT_PK
        );
        assertEq(tsla.balanceOf(address(fund)), 10e18, "post-check revierte tambien el swap");

        tight.maxConcentrationBps = 5000;
        tight.dailyTurnoverBps = 500;
        vm.prank(sponsor);
        controller.proposePolicy(tight, assets);
        vm.warp(controller.pendingPolicyEta());
        controller.activatePolicy();
        (AgentVaultController.TradeIntentV1 memory turnover, bytes memory turnoverData) =
            _intent(501_000000, 5.01e18, 4.96e18);
        _expectTradeRevert(AgentVaultController.TurnoverExceeded.selector, turnover, turnoverData, AGENT_PK);

        vm.warp(vm.getBlockTimestamp() + 1 days);
        (AgentVaultController.TradeIntentV1 memory freq1, bytes memory freqData1) =
            _intent(500_000000, 5e18, 4.95e18);
        controller.executeTrade(freq1, freqData1, _sign(AGENT_PK, controller.hashTradeIntent(freq1)));
        (AgentVaultController.TradeIntentV1 memory freq2, bytes memory freqData2) =
            _intent(100_000000, 1e18, 0.99e18);
        _expectTradeRevert(AgentVaultController.FrequencyExceeded.selector, freq2, freqData2, AGENT_PK);

        vm.warp(vm.getBlockTimestamp() + 1 days);
        (AgentVaultController.TradeIntentV1 memory slip, bytes memory slipData) =
            _intent(100_000000, 0.992e18, 0.99e18);
        _expectTradeRevert(AgentVaultController.SlippageExceeded.selector, slip, slipData, AGENT_PK);
    }

    function test_policy_timelock_y_pausa_local() public {
        AgentVaultController.Policy memory changed = _defaultPolicy();
        changed.maxTradeBps = 1500;
        vm.prank(sponsor);
        controller.proposePolicy(changed, _assets());
        vm.expectRevert(AgentVaultController.TimelockActive.selector);
        controller.activatePolicy();

        vm.prank(sponsor);
        controller.setPaused(true);
        (AgentVaultController.TradeIntentV1 memory intent, bytes memory data) =
            _intent(500_000000, 5e18, 4.95e18);
        _expectTradeRevert(AgentVaultController.ControllerPaused.selector, intent, data, AGENT_PK);
    }

    function test_fees_y_stake_terminan_en_sponsor() public {
        uint256 sponsorBefore = usdg.balanceOf(sponsor);
        usdg.mint(fund.FEE_SPLITTER(), 1_000_000000);
        controller.distributeManagerFeeToken(address(usdg));
        assertEq(usdg.balanceOf(sponsor), sponsorBefore + 900_000000);
        assertEq(usdg.balanceOf(treasury), 100_000000);

        vm.prank(sponsor);
        controller.requestWinding();
        vm.prank(keeper);
        fund.settle(0);
        vm.prank(sponsor);
        controller.close();
        vm.warp(block.timestamp + 30 days);
        vm.prank(sponsor);
        controller.finalizeClosure(new uint64[](0));
        assertEq(usdg.balanceOf(sponsor), sponsorBefore + 900_000000 + 10_000_000000);
        assertEq(usdg.balanceOf(address(controller)), 0);
    }

    function _intent(uint256 amountIn, uint256 amountOut, uint256 minOut)
        internal
        view
        returns (AgentVaultController.TradeIntentV1 memory intent, bytes memory data)
    {
        return _intentFor(address(tsla), amountIn, amountOut, minOut);
    }

    function _intentFor(address tokenOut, uint256 amountIn, uint256 amountOut, uint256 minOut)
        internal
        view
        returns (AgentVaultController.TradeIntentV1 memory intent, bytes memory data)
    {
        uint256 nowTs = vm.getBlockTimestamp();
        data = _adapterData(tokenOut, amountIn, amountOut, minOut, address(fund));
        intent = AgentVaultController.TradeIntentV1({
            agentId: AGENT_ID,
            fund: address(fund),
            tokenIn: address(usdg),
            tokenOut: tokenOut,
            amountIn: amountIn,
            minAmountOut: minOut,
            maxSlippageBps: 75,
            policyHash: controller.policyHash(),
            executionHash: keccak256(abi.encode(adapterId, data)),
            evidenceHash: keccak256("graph-context-and-reasoning"),
            nonce: controller.nextNonce(),
            validAfter: uint48(nowTs),
            deadline: uint48(nowTs + 5 minutes)
        });
    }

    function _adapterData(
        address tokenOut,
        uint256 amountIn,
        uint256 amountOut,
        uint256 minOut,
        address recipient
    )
        internal
        view
        returns (bytes memory)
    {
        uint256 nowTs = vm.getBlockTimestamp();
        bytes[] memory commands = new bytes[](0);
        return abi.encode(
            UniswapApiAdapter.ExecutionPlan({
                minAmountOut: minOut,
                deadline: uint48(nowTs + 5 minutes),
                callData: abi.encodeCall(
                    proxy.execute,
                    (
                        address(proxy),
                        address(usdg),
                        amountIn,
                        abi.encode(tokenOut, recipient, amountOut),
                        commands,
                        nowTs + 5 minutes
                    )
                )
            })
        );
    }

    function _defaultPolicy() internal pure returns (AgentVaultController.Policy memory) {
        return AgentVaultController.Policy({
            maxTradeBps: 1000,
            maxConcentrationBps: 3500,
            dailyTurnoverBps: 5000,
            maxSlippageBps: 75,
            maxTradesPerDay: 24,
            minTradeInterval: 5 minutes,
            maxIntentLifetime: 5 minutes
        });
    }

    function _assets() internal view returns (address[] memory assets) {
        assets = new address[](1);
        assets[0] = address(tsla);
    }

    function _activateAgent(address signer) internal {
        AgentRegistry.WorldBacking memory backing = AgentRegistry.WorldBacking({
            agentId: AGENT_ID,
            sponsor: sponsor,
            signer: signer,
            backingHash: keccak256("world-agentbook-proof"),
            agentBookBlock: 12_345,
            validUntil: uint48(block.timestamp + 90 days),
            nonce: agentRegistry.backingNonce(AGENT_ID)
        });
        agentRegistry.activate(backing, _sign(WORLD_PK, agentRegistry.hashWorldBacking(backing)));
    }

    function _sign(uint256 privateKey, bytes32 digest) internal returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(privateKey, digest);
        return abi.encodePacked(r, s, v);
    }

    function _expectTradeRevert(
        bytes4 selector,
        AgentVaultController.TradeIntentV1 memory intent,
        bytes memory data,
        uint256 signerKey
    ) internal {
        bytes memory signature = _sign(signerKey, controller.hashTradeIntent(intent));
        vm.expectRevert(selector);
        controller.executeTrade(intent, data, signature);
    }
}
