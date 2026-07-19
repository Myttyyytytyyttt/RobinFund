// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {Fund} from "../../src/Fund.sol";
import {TokenRegistry} from "../../src/TokenRegistry.sol";
import {IEligibilityGate} from "../../src/interfaces/IEligibilityGate.sol";
import {StakeEscrow} from "../../src/StakeEscrow.sol";
import {MockAccessRegistry, MockStockToken, MockUSDG, MockFeed, MockGate} from "../mocks/Mocks.sol";

/// @notice Regresiones de los §14 ataques y de los hallazgos de la revision 1.3a (S3, S4, S11, S12).
contract FundAttacksTest is Test {
    MockAccessRegistry access;
    MockStockToken tsla;
    MockUSDG usdg;
    MockFeed feed;
    MockGate gate;
    TokenRegistry reg;
    Fund fund;

    address manager = address(0x4A4A);
    address keeper = address(0x6E6E);
    address feeSplitter = address(0xFEE5);
    address treasury = address(0x7EA5);
    address alice = address(0xA11CE);
    address bob = address(0xB0B);

    uint32 constant PERIOD = 30 days;
    uint32 constant COOLDOWN = 24 hours;

    function setUp() public {
        vm.warp(100_000_000);
        access = new MockAccessRegistry();
        tsla = new MockStockToken("TSLA", access);
        usdg = new MockUSDG();
        feed = new MockFeed(100_00000000);
        gate = new MockGate();
        reg = new TokenRegistry(address(usdg));
        reg.list(address(tsla), address(feed), 90000, 1_00000000, 10000_00000000, address(0xBEEF));
        fund = new Fund(
            reg, IEligibilityGate(address(gate)), manager, keeper, feeSplitter, treasury,
            Fund.Config({perfFeeBps: 2000, feeMinBps: 0, feeMaxBps: 0, managerEntryShareBps: 5000, kFactor: 25, period: PERIOD, withdrawCooldown: COOLDOWN}),
            "A", "A"
        );
        usdg.mint(manager, 5000_000000);
        vm.startPrank(manager);
        usdg.approve(address(fund.stakeEscrow()), 5000_000000);
        fund.stakeEscrow().addStake(5000_000000);
        vm.stopPrank();
    }

    function _deposit(address lp, uint256 amt) internal {
        usdg.mint(lp, amt);
        vm.startPrank(lp);
        usdg.approve(address(fund), amt);
        fund.requestDeposit(amt);
        vm.stopPrank();
    }

    function _batch() internal {
        vm.warp(block.timestamp + 11 minutes);
        feed.set(feed.answer(), block.timestamp);
        fund.executeBatch(0);
    }

    function _seed(uint256 tslaAmt) internal {
        tsla.mint(address(fund), tslaAmt);
        vm.prank(keeper);
        fund.registerAsset(address(tsla));
    }

    // ---------- S11 / S3: keeper no puede reducir la salida del stake ----------

    function test_S11_keeper_subdeclarante_no_reduce_el_slash() public {
        _deposit(alice, 10_000_000000);
        _batch();
        uint256 fundBal = usdg.balanceOf(address(fund));
        vm.prank(address(fund));
        usdg.transfer(address(0xDEAD), fundBal);
        _seed(100e18); // 100 TSLA @ $100 = 10.000

        vm.warp(block.timestamp + PERIOD + 1);
        feed.set(80_00000000, block.timestamp); // NAV 8.000, perdida neta 2.000

        // keeper malicioso publica grossClaims = 0 → antes reducia funding a 0 (rug)
        vm.prank(keeper);
        fund.settle(0);

        // el stake se slashea igual: funding = min(stake, netted) es keeper-independiente
        assertApproxEqAbs(fund.reserve().funded(1), 2000_000000, 2, "funding = neteado, no lo baja el keeper");
        assertApproxEqAbs(fund.stakeEscrow().stakeAvailable(), 3000_000000, 2, "stake slasheado pese a grossClaims=0");
        // con grossClaims=0, lambda=0: los claims no se pagan aun, pero el dinero esta en la reserva
        (, uint128 lambda,,) = fund.settlements(1);
        assertEq(uint256(lambda), 0, "lambda 0: reparto congelado, pero el stake ya respondio");
    }

    function test_S11_keeper_sobredeclarante_solo_diluye_lambda() public {
        _deposit(alice, 10_000_000000);
        _batch();
        uint256 fundBal = usdg.balanceOf(address(fund));
        vm.prank(address(fund));
        usdg.transfer(address(0xDEAD), fundBal);
        _seed(100e18);

        vm.warp(block.timestamp + PERIOD + 1);
        feed.set(80_00000000, block.timestamp);

        // grossClaims inflado ×2 → lambda 0.5, alice cobra la mitad; el slash NO cambia
        vm.prank(keeper);
        fund.settle(4000e18);
        assertApproxEqAbs(fund.reserve().funded(1), 2000_000000, 2, "slash inmutable ante over-report");
        (, uint128 lambda,,) = fund.settlements(1);
        assertApproxEqRel(uint256(lambda), 0.5e18, 1e12, "lambda diluido a 0.5");

        vm.prank(alice);
        fund.claim();
        assertApproxEqAbs(usdg.balanceOf(alice), 1000_000000, 2, "cobra loss x lambda; residuo a la reserva");
    }

    // ---------- S4: la valvula in-kind funciona con NAV invalido ----------

    function test_S4_in_kind_funciona_con_nav_invalido() public {
        _deposit(alice, 10_000_000000);
        _batch();
        vm.prank(address(fund));
        usdg.transfer(address(0xDEAD), 5000_000000); // el fondo queda con ~5000 USDG + comprara TSLA (fix: cantidad fija, no prank-consumida)
        _seed(50e18); // 50 TSLA @ $100 = 5000

        uint256 aBal = fund.share().balanceOf(alice);
        vm.prank(alice);
        fund.requestWithdraw(aBal, true); // in-kind
        vm.warp(block.timestamp + COOLDOWN + 1);

        // feed muerto → NAV invalido → executeBatch revierte
        feed.setRevert(true);
        vm.expectRevert(Fund.NavInvalid.selector);
        fund.executeBatch(0);

        // pero la valvula in-kind SÍ ejecuta (pro-rata raw, sin precio)
        fund.executeInKindWithdrawals();
        assertEq(fund.share().balanceOf(alice), 0, "in-kind redimido sin NAV valido");
        assertEq(tsla.balanceOf(alice), 50e18, "recibe su pro-rata de TSLA");
        assertEq(usdg.balanceOf(alice), 5000_000000, "y de USDG");
    }

    function test_S4_in_kind_funciona_en_frozen() public {
        _deposit(alice, 5000_000000);
        _batch();
        uint256 aBal = fund.share().balanceOf(alice);
        vm.prank(alice);
        fund.requestWithdraw(aBal, true);
        vm.warp(block.timestamp + COOLDOWN + 1);

        // RHJ bloquea el fondo
        access.setBlocked(address(fund), true);
        fund.declareFrozen();

        fund.executeInKindWithdrawals();
        assertEq(fund.share().balanceOf(alice), 0, "salida garantizada incluso en Frozen (D12)");
        assertApproxEqAbs(usdg.balanceOf(alice), 5000_000000, 2);
    }

    // ---------- S12 #3: salir antes de la marca = NAV crudo, sin claim ----------

    function test_S12_salir_antes_de_la_marca_no_da_claim() public {
        _deposit(alice, 10_000_000000);
        _batch();
        uint256 fundBal = usdg.balanceOf(address(fund));
        vm.prank(address(fund));
        usdg.transfer(address(0xDEAD), fundBal);
        _seed(100e18);

        // el precio cae; alice retira in-kind ANTES del settlement
        feed.set(80_00000000, block.timestamp);
        uint256 aBal = fund.share().balanceOf(alice);
        vm.prank(alice);
        fund.requestWithdraw(aBal, true);
        vm.warp(block.timestamp + COOLDOWN + 1);
        feed.set(80_00000000, block.timestamp);
        fund.executeInKindWithdrawals();

        // salio a NAV crudo (su pro-rata de TSLA a $80); no queda para reclamar en el settlement
        assertEq(fund.share().balanceOf(alice), 0);
        vm.warp(block.timestamp + PERIOD + 1);
        feed.set(80_00000000, block.timestamp);
        vm.prank(keeper);
        fund.settle(0);
        vm.prank(alice);
        fund.claim();
        assertEq(usdg.balanceOf(alice), 0, "quien no aguanta hasta la marca no cobra first-loss");
    }

    // ---------- S12 #23: bucketing entre direcciones no extrae del stake ----------

    function test_S12_bucketing_entre_direcciones_no_extrae() public {
        // A y B (misma entidad) depositan; B vende el rally, A aguanta la caida.
        // El funding neteado a nivel de fondo incluye la ganancia realizada de B → no se puede cosechar.
        _deposit(alice, 5000_000000);
        _deposit(bob, 5000_000000);
        _batch();
        uint256 fundBal = usdg.balanceOf(address(fund));
        vm.prank(address(fund));
        usdg.transfer(address(0xDEAD), fundBal);
        _seed(100e18); // 10.000 en 100 TSLA @ $100

        // sube a $200: NAV 20.000. B retira in-kind (realiza ganancia)
        feed.set(200_00000000, block.timestamp);
        uint256 bBal = fund.share().balanceOf(bob);
        vm.prank(bob);
        fund.requestWithdraw(bBal, true);
        vm.warp(block.timestamp + COOLDOWN + 1);
        feed.set(200_00000000, block.timestamp);
        fund.executeInKindWithdrawals();

        // ahora cae a $50. A aguanta hasta la marca.
        vm.warp(block.timestamp + PERIOD);
        feed.set(50_00000000, block.timestamp);
        vm.prank(keeper);
        fund.settle(1e30); // gross alto: no ata

        // niAggregate incluye el NI negativo de B (vendio el rally) → neteado del fondo bajo
        // A cobra a lo sumo su perdida real, jamas una cosecha del stake
        vm.prank(alice);
        fund.claim();
        // A aporto 5000; su claim de por vida no puede exceder eso (invariante 2)
        assertLe(usdg.balanceOf(alice), 5000_000000, "claim <= aportado incluso con bucketing");
    }

    // ---------- Q6: _touch usa el balance corriente para períodos históricos — correcto porque
    // todo cambio de balance va precedido de _touch. Con un depósito ENTRE dos settlements sin tocar,
    // el balance es invariante en el rango no materializado. ----------

    function test_Q6_touch_balance_invariante_entre_settlements() public {
        _deposit(alice, 10_000_000000);
        _batch();
        uint256 fundBal = usdg.balanceOf(address(fund));
        vm.prank(address(fund));
        usdg.transfer(address(0xDEAD), fundBal);
        _seed(100e18);

        // Settlement 1 con pérdida (TSLA $80): alice NO toca (dormida)
        vm.warp(block.timestamp + PERIOD + 1);
        feed.set(80_00000000, block.timestamp);
        vm.prank(keeper);
        fund.settle(2000e18);

        // Settlement 2, aún dormida (TSLA $70)
        vm.warp(block.timestamp + PERIOD + 1);
        feed.set(70_00000000, block.timestamp);
        vm.prank(keeper);
        fund.settle(1000e18); // pérdida incremental desde $80

        // materializa los DOS períodos de golpe con el balance corriente (invariante entre ambos)
        vm.prank(alice);
        fund.claim();
        // claim total ≤ pérdida real ($10.000 → $7.000 = 3.000) y ≤ aportado
        assertLe(usdg.balanceOf(alice), 3000_000000, "claim acumulado <= perdida real");
        assertLe(usdg.balanceOf(alice), 10_000_000000, "claim <= aportado (invariante 2)");
        assertGt(usdg.balanceOf(alice), 0, "cobra algo de ambos periodos");
    }

    // ---------- S12 #13: reducción de stake es rug-safe (timelock + settlement + cap) ----------

    function test_S12_stake_withdraw_rug_safe() public {
        StakeEscrow se = fund.stakeEscrow();
        // el manager solicita retirar todo el stake
        vm.prank(manager);
        se.requestWithdraw(5000_000000);

        // no ejecutable fuera de settlement ni antes del timelock (el Fund solo lo invoca en _settle)
        assertEq(se.pendingWithdraw(), 5000_000000);

        // aún con timelock cumplido, si hay AUM el cap-check lo bloquea
        _deposit(alice, 10_000_000000);
        _batch();
        vm.warp(block.timestamp + 7 days + 1);
        vm.warp(block.timestamp + PERIOD); // llegar al settlement
        feed.set(feed.answer(), block.timestamp);
        vm.prank(keeper);
        fund.settle(0);
        // el cap resultante (k×0) < AUM ⇒ NO se ejecutó el retiro; el stake sigue
        assertGt(se.stakeAvailable(), 0, "no se puede retirar stake bajo AUM (cap-check)");
    }

    // ---------- S12 #2: blackout pre-settlement ----------

    function test_S12_blackout_pre_settlement() public {
        _deposit(alice, 1000_000000);
        _batch();
        // solicita deposito dentro de las 24h previas al settlement due
        vm.warp(fund.settlementDue() - 12 hours);
        _deposit(bob, 1000_000000);
        vm.warp(block.timestamp + 11 minutes);
        feed.set(feed.answer(), block.timestamp);
        fund.executeBatch(0);
        assertEq(fund.share().balanceOf(bob), 0, "deposito en blackout espera al post-settlement");
    }
}
