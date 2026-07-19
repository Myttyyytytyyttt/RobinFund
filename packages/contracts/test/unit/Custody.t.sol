// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {FundShare} from "../../src/FundShare.sol";
import {QueueEscrow} from "../../src/QueueEscrow.sol";
import {StakeEscrow} from "../../src/StakeEscrow.sol";
import {CompensationReserve} from "../../src/CompensationReserve.sol";
import {IERC20} from "../../src/interfaces/IERC20.sol";
import {MockUSDG} from "../mocks/Mocks.sol";

/// @notice Fase 1.2: los cuatro contratos de custodia. `fund` es este test (simula al Fund).
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
        stake = new StakeEscrow(address(this), IERC20(address(usdg)), manager, TIMELOCK);
        reserve = new CompensationReserve(address(this), IERC20(address(usdg)));
    }

    // ---------- FundShare (D7) ----------

    function test_share_mint_burn_solo_fund() public {
        share.mint(lp, 100e18);
        assertEq(share.balanceOf(lp), 100e18);
        assertEq(share.totalSupply(), 100e18);
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

    function test_share_burn_mas_de_lo_que_hay_revierte() public {
        share.mint(lp, 5e18);
        vm.expectRevert(); // underflow aritmetico
        share.burn(lp, 6e18);
    }

    // ---------- QueueEscrow (C11) ----------

    function test_queue_release_solo_fund() public {
        usdg.mint(address(queue), 1000_000000);
        assertEq(queue.balance(), 1000_000000);

        queue.release(lp, 400_000000); // refund al usuario
        queue.release(address(this), 600_000000); // batch ejecutado hacia el Fund
        assertEq(usdg.balanceOf(lp), 400_000000);
        assertEq(usdg.balanceOf(address(this)), 600_000000);
        assertEq(queue.balance(), 0);

        vm.prank(stranger);
        vm.expectRevert(QueueEscrow.NotFund.selector);
        queue.release(stranger, 1);
    }

    // ---------- StakeEscrow (§6) ----------

    function _fundStake(uint256 amount) internal {
        usdg.mint(manager, amount);
        vm.startPrank(manager);
        usdg.approve(address(stake), amount);
        stake.addStake(amount);
        vm.stopPrank();
    }

    function test_stake_add_y_available() public {
        _fundStake(2000_000000);
        assertEq(stake.stakeAvailable(), 2000_000000);
    }

    function test_stake_withdraw_timelock_completo() public {
        _fundStake(2000_000000);

        vm.prank(stranger);
        vm.expectRevert(StakeEscrow.NotManager.selector);
        stake.requestWithdraw(500_000000);

        vm.prank(manager);
        stake.requestWithdraw(500_000000);

        // antes del timelock: ni siquiera el Fund puede ejecutar
        vm.expectRevert(
            abi.encodeWithSelector(StakeEscrow.TimelockActive.selector, uint48(block.timestamp) + TIMELOCK)
        );
        stake.executeWithdraw();

        vm.warp(block.timestamp + TIMELOCK);
        uint256 out = stake.executeWithdraw();
        assertEq(out, 500_000000);
        assertEq(usdg.balanceOf(manager), 500_000000);
        assertEq(stake.stakeAvailable(), 1500_000000);
        assertEq(stake.withdrawExecutableAt(), 0, "solicitud limpiada");
    }

    function test_stake_pendiente_sigue_siendo_slashable() public {
        // Anti-rug (§14.13): solicitar reduccion no protege del first-loss
        _fundStake(2000_000000);
        vm.prank(manager);
        stake.requestWithdraw(2000_000000);
        vm.warp(block.timestamp + TIMELOCK);

        stake.slash(1800_000000, address(reserve)); // settlement con perdidas antes de ejecutar
        uint256 out = stake.executeWithdraw();
        assertEq(out, 200_000000, "solo queda lo no slasheado");
    }

    function test_stake_slash_solo_fund_y_acotado() public {
        _fundStake(1000_000000);
        vm.prank(stranger);
        vm.expectRevert(StakeEscrow.NotFund.selector);
        stake.slash(1, address(reserve));

        vm.expectRevert(StakeEscrow.InsufficientStake.selector);
        stake.slash(1000_000001, address(reserve));

        stake.slash(1000_000000, address(reserve));
        assertEq(usdg.balanceOf(address(reserve)), 1000_000000);
    }

    function test_stake_cancel_y_release() public {
        _fundStake(1000_000000);
        vm.prank(manager);
        stake.requestWithdraw(400_000000);
        vm.prank(manager);
        stake.cancelWithdraw();
        vm.expectRevert(StakeEscrow.NothingPending.selector);
        stake.executeWithdraw();

        uint256 all = stake.releaseAll();
        assertEq(all, 1000_000000);
        assertEq(usdg.balanceOf(manager), 1000_000000);
    }

    function test_stake_request_mayor_que_available_revierte() public {
        _fundStake(100_000000);
        vm.prank(manager);
        vm.expectRevert(StakeEscrow.InsufficientStake.selector);
        stake.requestWithdraw(100_000001);
    }

    // ---------- CompensationReserve (§6) ----------

    function test_reserve_flujo_fund_pay() public {
        // El slash del stake manda el USDG directamente a la reserve; el Fund registra el periodo
        _fundStake(2000_000000);
        stake.slash(500_000000, address(reserve));
        reserve.creditPeriod(1, 500_000000);
        assertEq(reserve.funded(1), 500_000000);

        reserve.pay(1, lp, 300_000000);
        assertEq(usdg.balanceOf(lp), 300_000000);
        assertEq(reserve.unclaimed(1), 200_000000);
    }

    function test_reserve_no_paga_mas_que_el_funding_del_periodo() public {
        _fundStake(1000_000000);
        stake.slash(500_000000, address(reserve));
        reserve.creditPeriod(1, 500_000000);

        vm.expectRevert(CompensationReserve.ExceedsFunding.selector);
        reserve.pay(1, lp, 500_000001);

        // ni cruzando periodos: el periodo 2 no existe aunque haya caja del 1
        vm.expectRevert(CompensationReserve.ExceedsFunding.selector);
        reserve.pay(2, lp, 1);
    }

    function test_reserve_credit_sin_caja_revierte() public {
        // El Fund no puede registrar funding que el USDG no respalda
        vm.expectRevert(CompensationReserve.UnderCollateralized.selector);
        reserve.creditPeriod(1, 100_000000);
    }

    function test_reserve_rollover_solo_hacia_delante_y_acotado() public {
        _fundStake(1000_000000);
        stake.slash(500_000000, address(reserve));
        reserve.creditPeriod(1, 500_000000);
        reserve.pay(1, lp, 100_000000);

        vm.expectRevert(CompensationReserve.ExceedsFunding.selector);
        reserve.rollover(1, 1, 100_000000); // mismo periodo

        vm.expectRevert(CompensationReserve.ExceedsFunding.selector);
        reserve.rollover(1, 2, 400_000001); // mas que lo no pagado

        reserve.rollover(1, 2, 400_000000);
        assertEq(reserve.funded(1), 100_000000);
        assertEq(reserve.funded(2), 400_000000);
        // el periodo destino puede pagar con lo rodado
        reserve.pay(2, lp, 400_000000);
    }

    function test_reserve_auth() public {
        vm.startPrank(stranger);
        vm.expectRevert(CompensationReserve.NotFund.selector);
        reserve.creditPeriod(1, 1);
        vm.expectRevert(CompensationReserve.NotFund.selector);
        reserve.pay(1, lp, 1);
        vm.expectRevert(CompensationReserve.NotFund.selector);
        reserve.rollover(1, 2, 1);
        vm.stopPrank();
    }
}
