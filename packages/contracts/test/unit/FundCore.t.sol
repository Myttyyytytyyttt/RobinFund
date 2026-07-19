// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {Fund} from "../../src/Fund.sol";
import {TokenRegistry} from "../../src/TokenRegistry.sol";
import {AdapterRegistry} from "../../src/AdapterRegistry.sol";
import {NAVLib} from "../../src/libraries/NAVLib.sol";
import {IEligibilityGate} from "../../src/interfaces/IEligibilityGate.sol";
import {IERC20} from "../../src/interfaces/IERC20.sol";
import {MockAccessRegistry, MockStockToken, MockUSDG, MockFeed, MockGate} from "../mocks/Mocks.sol";

/// @notice Fase 1.3a: flujos núcleo del Fund — colas, fees, NI, settlement, claims, estados.
contract FundCoreTest is Test {
    MockAccessRegistry access;
    MockStockToken tsla;
    MockUSDG usdg;
    MockFeed tslaFeed;
    MockGate gate;
    TokenRegistry reg;
    AdapterRegistry adapters;
    Fund fund;

    address manager = address(0x4A4A);
    address keeper = address(0x6E6E);
    address feeSplitter = address(0xFEE5);
    address treasury = address(0x7EA5);
    address alice = address(0xA11CE);
    address bob = address(0xB0B);

    uint48 constant STALENESS = 90000;
    uint32 constant PERIOD = 30 days;
    uint32 constant COOLDOWN = 24 hours;

    function setUp() public {
        vm.warp(100_000_000);
        access = new MockAccessRegistry();
        tsla = new MockStockToken("TSLA", access);
        usdg = new MockUSDG();
        tslaFeed = new MockFeed(100_00000000); // $100 para números redondos
        gate = new MockGate();
        reg = new TokenRegistry(address(usdg));
        reg.list(address(tsla), address(tslaFeed), STALENESS, 1_00000000, 10000_00000000, address(0xBEEF));

        adapters = new AdapterRegistry();
        fund = new Fund(
            reg,
            IEligibilityGate(address(gate)),
            adapters,
            manager,
            keeper,
            feeSplitter,
            treasury,
            Fund.Config({
                perfFeeBps: 2000, // 20%
                feeMinBps: 0,
                feeMaxBps: 0, // sin entry fee en los flujos base; se activa por test
                managerEntryShareBps: 5000,
                kFactor: 25,
                period: PERIOD,
                withdrawCooldown: COOLDOWN
            }),
            "RobinFund Alpha",
            "rfALPHA"
        );

        // stake del manager: 2.000 USDG → cap 50.000
        usdg.mint(manager, 2000_000000);
        vm.startPrank(manager);
        usdg.approve(address(fund.stakeEscrow()), 2000_000000);
        fund.stakeEscrow().addStake(2000_000000);
        vm.stopPrank();
    }

    // ---------- Helpers ----------

    function _deposit(address lp, uint256 amount6) internal returns (uint256 id) {
        usdg.mint(lp, amount6);
        vm.startPrank(lp);
        usdg.approve(address(fund), amount6);
        id = fund.requestDeposit(amount6);
        vm.stopPrank();
    }

    function _executeAfterLatency() internal {
        vm.warp(block.timestamp + 11 minutes);
        // frescura: la ronda debe ser posterior a la solicitud
        tslaFeed.set(tslaFeed.answer(), block.timestamp);
        fund.executeBatch(0);
    }

    function _seedFundWithTsla(uint256 tslaAmount) internal {
        tsla.mint(address(fund), tslaAmount);
        vm.prank(keeper); // el adapter (1.4) registra; en 1.3a lo simula el keeper
        fund.registerAsset(address(tsla));
    }

    // ---------- Depósitos ----------

    function test_deposito_flujo_completo() public {
        uint256 id = _deposit(alice, 1000_000000);
        assertEq(fund.queuedDeposits6(), 1000_000000);
        assertEq(usdg.balanceOf(address(fund.queue())), 1000_000000, "USDG en el escrow, no en el fondo");

        _executeAfterLatency();

        assertApproxEqRel(fund.share().balanceOf(alice), 1000e18, 1e12, "shares a precio seed 1.0");
        assertEq(usdg.balanceOf(address(fund)), 1000_000000, "USDG movido al fondo");
        assertEq(fund.queuedDeposits6(), 0);
        Fund.Account memory a = fund.accountOf(alice);
        assertEq(a.niWad, int256(1000e18), "NI = cash neto");
        id; // silence
    }

    function test_deposito_sin_latencia_no_ejecuta() public {
        _deposit(alice, 1000_000000);
        tslaFeed.set(tslaFeed.answer(), block.timestamp); // ronda fresca pero orden recién puesta
        fund.executeBatch(0);
        assertEq(fund.share().balanceOf(alice), 0, "forward pricing: espera latencia + ronda posterior");
    }

    function test_deposito_bajo_minimo_revierte() public {
        usdg.mint(alice, 10_000000);
        vm.startPrank(alice);
        usdg.approve(address(fund), 10_000000);
        vm.expectRevert(Fund.BelowMinimum.selector);
        fund.requestDeposit(10_000000);
        vm.stopPrank();
    }

    function test_deposito_inelegible_revierte_y_refund_si_caduca() public {
        gate.setIneligible(alice, true);
        usdg.mint(alice, 100_000000);
        vm.startPrank(alice);
        usdg.approve(address(fund), 100_000000);
        vm.expectRevert(Fund.NotEligible.selector);
        fund.requestDeposit(100_000000);
        vm.stopPrank();

        // elegible al solicitar, caduca antes del batch → skip + refund (C21)
        gate.setIneligible(alice, false);
        _deposit(alice, 100_000000); // mint 100 más; alice tiene 100 (del revert) + 100 → escrow toma 100
        gate.setIneligible(alice, true);
        _executeAfterLatency();
        assertEq(fund.share().balanceOf(alice), 0);
        assertEq(usdg.balanceOf(alice), 200_000000, "refund automatico (100 sobrante + 100 refund)");
        assertEq(fund.queue().balance(), 0, "escrow vaciado");
    }

    function test_deposito_cancelable() public {
        uint256 id = _deposit(alice, 500_000000);
        vm.prank(alice);
        fund.cancelDeposit(id);
        assertEq(usdg.balanceOf(alice), 500_000000);
        _executeAfterLatency();
        assertEq(fund.share().balanceOf(alice), 0);
    }

    function test_deposito_sobre_cap_espera() public {
        // cap = 25 × 2000 = 50.000 USDG
        _deposit(alice, 49_000_000000);
        _executeAfterLatency();
        assertGt(fund.share().balanceOf(alice), 0);

        _deposit(bob, 2_000_000000); // 49k + 2k > 50k
        _executeAfterLatency();
        assertEq(fund.share().balanceOf(bob), 0, "espera a que suba el cap");
    }

    // ---------- Entry fee ----------

    function test_entry_fee_split_y_hwm() public {
        // fondo nuevo con fee activa
        Fund f2 = new Fund(
            reg,
            IEligibilityGate(address(gate)),
            adapters,
            manager,
            keeper,
            feeSplitter,
            treasury,
            Fund.Config({
                perfFeeBps: 2000,
                feeMinBps: 100, // 1% fijo (min=max)
                feeMaxBps: 100,
                managerEntryShareBps: 5000,
                kFactor: 25,
                period: PERIOD,
                withdrawCooldown: COOLDOWN
            }),
            "F2",
            "F2"
        );
        usdg.mint(manager, 2000_000000);
        vm.startPrank(manager);
        usdg.approve(address(f2.stakeEscrow()), 2000_000000);
        f2.stakeEscrow().addStake(2000_000000);
        vm.stopPrank();

        usdg.mint(alice, 1000_000000);
        vm.startPrank(alice);
        usdg.approve(address(f2), 1000_000000);
        f2.requestDeposit(1000_000000);
        vm.stopPrank();
        vm.warp(block.timestamp + 11 minutes);
        tslaFeed.set(tslaFeed.answer(), block.timestamp);
        f2.executeBatch(0);

        // fee = 1% de 1000 = 10; 20% protocolo = 2; 50% manager = 5; 30% fondo = 3
        assertEq(usdg.balanceOf(treasury), 2_000000);
        assertEq(usdg.balanceOf(manager), 5_000000);
        assertEq(usdg.balanceOf(address(f2)), 993_000000, "990 netos + 3 fee-fondo");
        // el primer depositante recibe shares sobre el neto; la fee-fondo pre-mint le pertenece via NAV
    }

    // ---------- Retiros ----------

    function test_retiro_cash_flujo_completo() public {
        _deposit(alice, 1000_000000);
        _executeAfterLatency();
        uint256 shares = fund.share().balanceOf(alice);

        vm.prank(alice);
        fund.requestWithdraw(shares / 2, false);
        // antes del cooldown no ejecuta
        fund.executeBatch(0);
        assertEq(fund.share().balanceOf(alice), shares);

        vm.warp(block.timestamp + COOLDOWN + 1);
        tslaFeed.set(tslaFeed.answer(), block.timestamp);
        fund.executeBatch(0);

        assertEq(fund.share().balanceOf(alice), shares - shares / 2);
        assertApproxEqAbs(usdg.balanceOf(alice), 500_000000, 2, "cobra a NAV");
        Fund.Account memory a = fund.accountOf(alice);
        assertApproxEqAbs(uint256(a.niWad), 500e18, 1e13, "NI reducido por proceeds");
    }

    function test_retiro_cancelable_solo_antes_del_cooldown() public {
        _deposit(alice, 1000_000000);
        _executeAfterLatency();
        vm.prank(alice);
        uint256 id = fund.requestWithdraw(100e18, false);

        vm.warp(block.timestamp + COOLDOWN + 1);
        vm.prank(alice);
        vm.expectRevert(Fund.CooldownActive.selector);
        fund.cancelWithdraw(id);
    }

    function test_shares_bloqueadas_no_se_pueden_re_solicitar() public {
        _deposit(alice, 1000_000000);
        _executeAfterLatency();
        uint256 shares = fund.share().balanceOf(alice);
        vm.startPrank(alice);
        fund.requestWithdraw(shares, false);
        vm.expectRevert(Fund.SharesLocked.selector);
        fund.requestWithdraw(1, false);
        vm.stopPrank();
    }

    // ---------- Settlement + first-loss + claims ----------

    function _setupLossScenario() internal returns (uint256 aliceShares) {
        // alice deposita 10.000; el fondo compra (simulado) 100 TSLA a $100 = 10.000
        _deposit(alice, 10_000_000000);
        _executeAfterLatency();
        aliceShares = fund.share().balanceOf(alice);
        // simular compra: el USDG sale (a un "venue"), entran 100 TSLA
        vm.prank(address(fund));
        usdg.transfer(address(0xDEAD), 10_000_000000);
        _seedFundWithTsla(100e18);
    }

    function test_settlement_con_perdida_funding_y_claim() public {
        uint256 aliceShares = _setupLossScenario();
        aliceShares;

        // TSLA cae a $80: NAV 8.000, pérdida real de alice = 2.000, NI = 10.000
        vm.warp(block.timestamp + PERIOD + 1);
        tslaFeed.set(80_00000000, block.timestamp);

        // grossClaims honesto: pérdida de alice con cobertura completa (edad ≥ período) = 2.000
        vm.prank(keeper);
        fund.settle(2000e18);

        (uint128 pe, uint128 lambda,, bool degraded) = fund.settlements(1);
        assertFalse(degraded);
        assertApproxEqRel(uint256(pe), 0.8e18, 1e12, "Pe = 0.80");
        // netted (~2000) < stake (2000) por el ruido del offset virtual → lambda ~1 (no exacto)
        assertApproxEqRel(uint256(lambda), 1e18, 1e9, "stake cubre el neto: lambda ~ 1");
        assertApproxEqAbs(fund.reserve().funded(1), 2000_000000, 1, "funding = min(stake, neteado, gross)");

        // claim pull: alice cobra su pérdida (restaurada, jamás beneficiada)
        vm.prank(alice);
        fund.claim();
        assertApproxEqAbs(usdg.balanceOf(alice), 2000_000000, 3, "restaurada, no beneficiada");
        assertLe(usdg.balanceOf(alice), 2000_000000, "claim <= perdida real (invariante 1)");
        Fund.Account memory a = fund.accountOf(alice);
        assertApproxEqAbs(uint256(a.niWad), 8000e18, 1e15, "NI reducido por el claim");

        // segundo settlement al mismo precio: sin doble claim
        vm.warp(block.timestamp + PERIOD + 1);
        tslaFeed.set(80_00000000, block.timestamp);
        vm.prank(keeper);
        fund.settle(0);
        vm.prank(alice);
        fund.claim();
        assertApproxEqAbs(usdg.balanceOf(alice), 2000_000000, 2, "sin compounding (v0.6)");
    }

    function test_vesting_deposito_reciente_cobertura_parcial() public {
        _setupLossScenario(); // alice: 10.000 en 100 TSLA @ $100
        // bob entra 15 días antes de la marca → cobertura ~50%
        vm.warp(block.timestamp + PERIOD - 15 days);
        _deposit(bob, 1000_000000);
        _executeAfterLatency();

        uint256 bobShares = fund.share().balanceOf(bob);
        uint256 bobNi = uint256(fund.accountOf(bob).niWad); // 1000e18

        vm.warp(block.timestamp + 15 days - 11 minutes);
        tslaFeed.set(80_00000000, block.timestamp); // TSLA $80
        vm.prank(keeper);
        fund.settle(3000e18); // gross alto: no ata el funding (lo ata stake/neteado)

        (uint128 pe, uint128 lambda,,) = fund.settlements(1);
        // pérdida REAL de mercado de bob a la marca
        uint256 bobLossWad = bobNi - bobShares * uint256(pe) / 1e18;

        vm.prank(bob);
        fund.claim();
        uint256 bobClaim6 = usdg.balanceOf(bob);

        // Propiedad del vesting: 0 < claim < pérdida_real × λ (cobertura ~50%, no 100%)
        assertGt(bobClaim6, 0, "cobertura parcial > 0");
        uint256 fullyVested6 = (bobLossWad * uint256(lambda) / 1e18) / 1e12;
        assertLt(bobClaim6, fullyVested6, "claim < el de cobertura completa");
        // banda: cobertura entre 40% y 60% de lo que cobraría con vesting completo
        assertGt(bobClaim6 * 100, fullyVested6 * 40);
        assertLt(bobClaim6 * 100, fullyVested6 * 60);
    }

    function test_perf_fee_con_ganancia() public {
        _setupLossScenario();
        // TSLA sube a $120: NAV 12.000, Pe 1.2 > HWM 1.0
        vm.warp(block.timestamp + PERIOD + 1);
        tslaFeed.set(120_00000000, block.timestamp);
        vm.prank(keeper);
        fund.settle(0);

        // fee = 20% × ganancia 2000 = 400 → shares al FeeSplitter, valoradas a P_final (post-dilución)
        uint256 feeShares = fund.share().balanceOf(feeSplitter);
        assertGt(feeShares, 0);
        uint256 pFinal = fund.hwmWad(); // HWM := P_final tras cristalizar
        assertApproxEqRel(feeShares * pFinal / 1e18, 400e18, 0.01e18, "valor fee shares a P_final = 400");
        (uint128 pe,,,) = fund.settlements(1);
        assertLt(pFinal, uint256(pe), "P_final < Pe por la dilucion");
        assertEq(fund.reserve().funded(1), 0, "sin funding en ganancia");
    }

    function test_settlement_sin_ventana_valida_espera_y_luego_degradado() public {
        _setupLossScenario();
        vm.warp(block.timestamp + PERIOD + 1);
        // feed stale → NAV inválido → el keeper no puede settlear aún
        vm.prank(keeper);
        vm.expectRevert(Fund.NavInvalid.selector);
        fund.settle(0);

        // pasados 7 días sin ventana válida: settlement degradado, perf fee omitida
        vm.warp(block.timestamp + 7 days + 1);
        vm.prank(keeper);
        fund.settle(0);
        (,,, bool degraded) = fund.settlements(1);
        assertTrue(degraded);
    }

    // ---------- Estados ----------

    function test_winding_y_cierre_completo() public {
        _deposit(alice, 1000_000000);
        _executeAfterLatency();
        uint256 shares = fund.share().balanceOf(alice);

        // depósito pendiente que será anulado por el winding
        _deposit(bob, 500_000000);

        vm.prank(manager);
        fund.requestWinding();
        assertEq(uint8(fund.state()), uint8(Fund.State.PendingWinding));

        // settlement ad-hoc con due = solicitud
        tslaFeed.set(tslaFeed.answer(), block.timestamp);
        vm.prank(keeper);
        fund.settle(0);
        assertEq(uint8(fund.state()), uint8(Fund.State.Winding));
        assertEq(usdg.balanceOf(bob), 500_000000, "deposito anulado con refund (C11)");

        // retiro sin cooldown en Winding
        vm.prank(alice);
        fund.requestWithdraw(shares, false);
        vm.warp(block.timestamp + 11 minutes);
        tslaFeed.set(tslaFeed.answer(), block.timestamp);
        fund.executeBatch(0);
        assertEq(fund.share().balanceOf(alice), 0, "salida inmediata en Winding");

        // cierre: sin activos, sin shares → release two-step + residuo
        vm.prank(manager);
        fund.close();
        assertEq(uint8(fund.state()), uint8(Fund.State.Closed));

        vm.warp(block.timestamp + 30 days + 1);
        uint64[] memory none = new uint64[](0);
        fund.finalizeClosure(none);
        assertEq(usdg.balanceOf(manager), 2000_000000, "stake liberado tras la gracia");
    }

    function test_force_redeem_por_compliance() public {
        _deposit(alice, 1000_000000);
        _executeAfterLatency();
        gate.setIneligible(alice, true);

        // antes de la gracia: no
        vm.expectRevert(Fund.StillEligible.selector);
        fund.forceRedeem(alice);

        vm.warp(block.timestamp + 30 days + 1);
        fund.forceRedeem(alice); // cualquiera puede, sin cooldown

        // el settlement está vencido (grace = period = 30d): el keeper settlea y luego el batch redime
        tslaFeed.set(tslaFeed.answer(), block.timestamp);
        vm.prank(keeper);
        fund.settle(0);
        vm.warp(block.timestamp + 11 minutes);
        tslaFeed.set(tslaFeed.answer(), block.timestamp - 1);
        fund.executeBatch(0);

        assertEq(fund.share().balanceOf(alice), 0, "redimido a USDG");
        assertApproxEqAbs(usdg.balanceOf(alice), 1000_000000, 2, "cobra su NAV");
    }

    function test_claim_funciona_sin_estado_ni_nav() public {
        // G15: el entrypoint de claims no depende de nada
        _setupLossScenario();
        vm.warp(block.timestamp + PERIOD + 1);
        tslaFeed.set(80_00000000, block.timestamp);
        vm.prank(keeper);
        fund.settle(2000e18);

        // feed muerto + fondo "bloqueado" después del settlement: claim sigue funcionando
        tslaFeed.setRevert(true);
        access.setBlocked(address(fund), true);
        vm.prank(alice);
        fund.claim();
        assertGt(usdg.balanceOf(alice), 0, "claim vive en cualquier estado");
    }
}
