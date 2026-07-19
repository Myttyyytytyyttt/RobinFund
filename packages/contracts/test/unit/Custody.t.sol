// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {FundShare} from "../../src/FundShare.sol";
import {QueueEscrow} from "../../src/QueueEscrow.sol";
import {StakeEscrow} from "../../src/StakeEscrow.sol";
import {CompensationReserve} from "../../src/CompensationReserve.sol";
import {IERC20} from "../../src/interfaces/IERC20.sol";
import {MockUSDG} from "../mocks/Mocks.sol";

/// @notice Fase 1.2 (revisión aplicada): los cuatro contratos de custodia. `fund` = este test.
contract CustodyTest is Test {
    MockUSDG usdg;
    FundShare share;
    QueueEscrow queue;
    StakeEscrow stake;
    CompensationReserve reserve;

    address manager = address(0x4A4A);
    address lp = address(0x1111);
    address stranger = address(0xBAD);
    uint48 constant TIMELOCK = 7 days;

    function setUp() public {
        vm.warp(10_000_000);
        usdg = new MockUSDG();
        share = new FundShare("RobinFund Alpha", "rfALPHA", address(this));
        queue = new QueueEscrow(address(this), IERC20(address(usdg)));
        reserve = new CompensationReserve(address(this), IERC20(address(usdg)));
        stake = new StakeEscrow(address(this), IERC20(address(usdg)), manager, address(reserve), TIMELOCK);
    }

    function _fundStake(uint256 amount) internal {
        usdg.mint(manager, amount);
        vm.startPrank(manager);
        usdg.approve(address(stake), amount);
        stake.addStake(amount);
        vm.stopPrank();
    }

    // ---------- FundShare (D7) ----------

    function test_share_mint_burn_solo_fund() public {
        share.mint(lp, 100e18);
        assertEq(share.balanceOf(lp), 100e18);
        share.burn(lp, 40e18);
        assertEq(share.balanceOf(lp), 60e18);

        vm.startPrank(stranger);
        vm.expectRevert(FundShare.NotFund.selector);
        share.mint(stranger, 1);
        vm.expectRevert(FundShare.NotFund.selector);
        share.burn(lp, 1);
        vm.stopPrank();
    }

    function test_share_no_transferible() public {
        share.mint(lp, 10e18);
        vm.startPrank(lp);
        vm.expectRevert(FundShare.NonTransferable.selector);
        share.transfer(stranger, 1);
        vm.expectRevert(FundShare.NonTransferable.selector);
        share.transferFrom(lp, stranger, 1);
        vm.expectRevert(FundShare.NonTransferable.selector);
        share.approve(stranger, 1);
        vm.stopPrank();
        assertEq(share.allowance(lp, stranger), 0);
    }

    function test_share_burn_excesivo_revierte() public {
        share.mint(lp, 5e18);
        vm.expectRevert();
        share.burn(lp, 6e18);
    }

    // ---------- QueueEscrow (C11) ----------

    function test_queue_release_solo_fund() public {
        usdg.mint(address(queue), 1000_000000);
        queue.release(lp, 400_000000);
        queue.release(address(this), 600_000000);
        assertEq(usdg.balanceOf(lp), 400_000000);
        assertEq(usdg.balanceOf(address(this)), 600_000000);
        assertEq(queue.balance(), 0);

        vm.prank(stranger);
        vm.expectRevert(QueueEscrow.NotFund.selector);
        queue.release(stranger, 1);
    }

    // ---------- StakeEscrow: timelock y ventana (G3) ----------

    function test_stake_withdraw_timelock_y_ventana() public {
        _fundStake(2000_000000);

        vm.prank(stranger);
        vm.expectRevert(StakeEscrow.NotManager.selector);
        stake.requestWithdraw(500_000000);

        vm.prank(manager);
        stake.requestWithdraw(500_000000);
        uint48 executableAt = uint48(block.timestamp) + TIMELOCK;

        vm.expectRevert(abi.encodeWithSelector(StakeEscrow.TimelockActive.selector, executableAt));
        stake.executeWithdraw();

        vm.warp(executableAt);
        assertEq(stake.executeWithdraw(), 500_000000);
        assertEq(usdg.balanceOf(manager), 500_000000);
        assertEq(stake.withdrawExecutableAt(), 0);
    }

    function test_stake_solicitud_caduca_a_los_30d() public {
        // G3-A: sin opción de salida permanente — la solicitud madurada caduca
        _fundStake(1000_000000);
        vm.prank(manager);
        stake.requestWithdraw(1000_000000);
        vm.warp(block.timestamp + TIMELOCK + stake.EXECUTION_WINDOW() + 1);
        vm.expectRevert(StakeEscrow.RequestExpired.selector);
        stake.executeWithdraw();
    }

    function test_stake_re_solicitar_reinicia_el_timelock() public {
        // G13-1: la re-solicitud pisa la anterior y reinicia el reloj
        _fundStake(1000_000000);
        vm.prank(manager);
        stake.requestWithdraw(100_000000);
        vm.warp(block.timestamp + TIMELOCK);
        vm.prank(manager);
        stake.requestWithdraw(900_000000);
        vm.expectRevert(
            abi.encodeWithSelector(StakeEscrow.TimelockActive.selector, uint48(block.timestamp) + TIMELOCK)
        );
        stake.executeWithdraw();
    }

    function test_stake_slash_reduce_lo_solicitado() public {
        // G3-B: el stake añadido tras la solicitud NO sale por la solicitud vieja
        _fundStake(1000_000000);
        vm.prank(manager);
        stake.requestWithdraw(1000_000000);
        vm.warp(block.timestamp + TIMELOCK);

        stake.slash(500_000000); // settlement con pérdidas
        _fundStake(600_000000); // top-up posterior (balance 1100)

        assertEq(stake.executeWithdraw(), 500_000000, "solo sale el remanente de lo solicitado");
        assertEq(stake.stakeAvailable(), 600_000000, "el stake fresco queda dentro");
    }

    function test_stake_slash_total_deja_withdraw_a_cero() public {
        // G13-3: slash del 100% con solicitud pendiente — paga 0 y limpia
        _fundStake(1000_000000);
        vm.prank(manager);
        stake.requestWithdraw(1000_000000);
        vm.warp(block.timestamp + TIMELOCK);
        stake.slash(1000_000000);
        assertEq(stake.executeWithdraw(), 0);
        assertEq(stake.withdrawExecutableAt(), 0);
    }

    function test_stake_slash_solo_fund_solo_reserve_y_acotado() public {
        _fundStake(1000_000000);
        vm.prank(stranger);
        vm.expectRevert(StakeEscrow.NotFund.selector);
        stake.slash(1);

        vm.expectRevert(StakeEscrow.InsufficientStake.selector);
        stake.slash(1000_000001);

        stake.slash(1000_000000);
        assertEq(usdg.balanceOf(address(reserve)), 1000_000000, "el slash SOLO puede ir a la reserve (G5)");
    }

    function test_stake_release_two_step_con_gracia() public {
        // G1: la gracia de 30d vive en el escrow, no en promesas del Fund
        _fundStake(1000_000000);

        vm.expectRevert(StakeEscrow.ReleaseNotStarted.selector);
        stake.releaseAll();

        stake.startRelease();
        vm.expectRevert(
            abi.encodeWithSelector(StakeEscrow.GraceActive.selector, uint48(block.timestamp) + stake.RELEASE_GRACE())
        );
        stake.releaseAll();

        vm.warp(block.timestamp + stake.RELEASE_GRACE());
        assertEq(stake.releaseAll(), 1000_000000);
        assertEq(usdg.balanceOf(manager), 1000_000000);
    }

    function test_stake_donacion_directa_sube_available() public {
        // G13-4: contabilidad por balance — una donación cuenta (documentado; solo beneficia a LPs)
        usdg.mint(address(stake), 100_000000);
        assertEq(stake.stakeAvailable(), 100_000000);
    }

    function test_stake_constructor_guards() public {
        vm.expectRevert(StakeEscrow.BadTimelock.selector);
        new StakeEscrow(address(this), IERC20(address(usdg)), manager, address(reserve), 1 hours);
        vm.expectRevert(StakeEscrow.ZeroAddress.selector);
        new StakeEscrow(address(0), IERC20(address(usdg)), manager, address(reserve), TIMELOCK);
        vm.expectRevert(StakeEscrow.ZeroAddress.selector);
        new StakeEscrow(address(this), IERC20(address(0xDEAD)), manager, address(reserve), TIMELOCK); // sin código
    }

    // ---------- CompensationReserve (§6) ----------

    function test_reserve_flujo_slash_credit_pay() public {
        _fundStake(2000_000000);
        stake.slash(500_000000);
        reserve.creditPeriod(1, 500_000000);
        assertEq(reserve.funded(1), 500_000000);

        reserve.pay(1, lp, 300_000000);
        assertEq(usdg.balanceOf(lp), 300_000000);
        assertEq(reserve.unclaimed(1), 200_000000);
    }

    function test_reserve_no_paga_mas_que_el_funding_del_periodo() public {
        _fundStake(1000_000000);
        stake.slash(500_000000);
        reserve.creditPeriod(1, 500_000000);

        vm.expectRevert(CompensationReserve.ExceedsFunding.selector);
        reserve.pay(1, lp, 500_000001);
        vm.expectRevert(CompensationReserve.ExceedsFunding.selector);
        reserve.pay(2, lp, 1);
    }

    function test_reserve_credit_sin_caja_revierte() public {
        vm.expectRevert(CompensationReserve.UnderCollateralized.selector);
        reserve.creditPeriod(1, 100_000000);
    }

    function test_reserve_sweep_residuo() public {
        // v0.9 (G2): el residuo se barre en Closed (totalShares=0), no rueda entre períodos
        _fundStake(1000_000000);
        stake.slash(500_000000);
        reserve.creditPeriod(1, 500_000000);
        reserve.pay(1, lp, 100_000000);

        uint256 swept = reserve.sweep(1, manager);
        assertEq(swept, 400_000000);
        assertEq(usdg.balanceOf(manager), 400_000000);
        assertEq(reserve.unclaimed(1), 0);
        // tras el sweep no queda nada pagable en el período
        vm.expectRevert(CompensationReserve.ExceedsFunding.selector);
        reserve.pay(1, lp, 1);
    }

    function test_reserve_auth() public {
        vm.startPrank(stranger);
        vm.expectRevert(CompensationReserve.NotFund.selector);
        reserve.creditPeriod(1, 1);
        vm.expectRevert(CompensationReserve.NotFund.selector);
        reserve.pay(1, lp, 1);
        vm.expectRevert(CompensationReserve.NotFund.selector);
        reserve.sweep(1, lp);
        vm.stopPrank();
    }
}
