// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test, console2} from "forge-std/Test.sol";
import {AddressBook} from "../../src/AddressBook.sol";
import {TokenRegistry} from "../../src/TokenRegistry.sol";
import {AdapterRegistry} from "../../src/AdapterRegistry.sol";
import {Fund} from "../../src/Fund.sol";
import {UniswapV4Adapter, IPoolManager, PoolKey} from "../../src/adapters/UniswapV4Adapter.sol";
import {IEligibilityGate} from "../../src/interfaces/IEligibilityGate.sol";
import {IAggregatorV3, IBeacon} from "../../src/interfaces/IAggregatorV3.sol";
import {IERC20} from "../../src/interfaces/IERC20.sol";
import {MockGate} from "../mocks/Mocks.sol";

/// @notice Fase 1.4: el manager tradea USDG↔TSLA por el Uniswap v4 REAL de la chain, con el
/// guardarraíl de slippage midiendo contra el feed Chainlink REAL. Contra fork de mainnet 4663.
contract TradingForkTest is Test {
    // El fork está en fin de semana (feeds ~34h stale). En producción maxStaleness = 86400+margen y
    // el trading de finde queda BLOQUEADO por el guardarraíl (comportamiento correcto, T1). Para
    // testear la MECÁNICA del trade ampliamos la tolerancia al staleness del fork.
    uint48 constant STALENESS = 10 days;
    address constant DONOR = 0x000000000000000000000000000000000000dEaD;

    TokenRegistry reg;
    AdapterRegistry adapters;
    UniswapV4Adapter adapter;
    Fund fund;
    MockGate gate;
    uint256 adapterId;

    address manager = address(0x4A4A);
    address keeper = address(0x6E6E);
    address alice = address(0xA11CE);

    function setUp() public {
        vm.createSelectFork(vm.envString("RH_RPC_MAINNET"));
        gate = new MockGate();
        reg = new TokenRegistry(AddressBook.USDG);
        address impl = IBeacon(AddressBook.ACCESS_REGISTRY).implementation();
        reg.list(AddressBook.TSLA, AddressBook.TSLA_FEED, STALENESS, 1_00000000, 100_000_00000000, impl);
        reg.setUsdgFeed(AddressBook.USDG_FEED, STALENESS, 90000000, 110000000);

        adapters = new AdapterRegistry();
        adapter = new UniswapV4Adapter(IPoolManager(AddressBook.UNI_V4_POOL_MANAGER));
        adapterId = adapters.add(address(adapter));

        fund = new Fund(
            reg,
            IEligibilityGate(address(gate)),
            adapters,
            address(0x6DAD), // guardian
            manager,
            keeper,
            address(0x7EA5), // treasury
            Fund.Config({
                perfFeeBps: 2000, feeMinBps: 0, feeMaxBps: 0, managerEntryShareBps: 5000,
                kFactor: 25, period: 30 days, withdrawCooldown: 24 hours
            }),
            "RF-Fork", "RFF"
        );

        // stake del manager (USDG via deal — el donante 0xdEaD no tiene USDG suficiente)
        deal(AddressBook.USDG, manager, 20_000_000000);
        vm.startPrank(manager);
        IERC20(AddressBook.USDG).approve(address(fund.stakeEscrow()), 5000_000000);
        fund.stakeEscrow().addStake(5000_000000);
        vm.stopPrank();
    }

    function _poolKey() internal pure returns (bytes memory) {
        // TSLA/USDG v4: fee 3000, tickSpacing 60, sin hooks (descubierto en Fase 0)
        return abi.encode(
            PoolKey({currency0: AddressBook.TSLA, currency1: AddressBook.USDG, fee: 3000, tickSpacing: 60, hooks: address(0)})
        );
    }

    /// @dev El flujo de depósito (colas/forward pricing) está unit-testeado; aquí solo probamos el
    /// TRADING contra Uniswap real, que opera sobre el balance de USDG del fondo. Con los feeds reales
    /// stale de fin de semana el forward pricing no ejecutaría el depósito, así que `deal`eamos el USDG
    /// al fondo directamente (execute() no toca shares ni NI, solo balances de tokens).
    function _fundHasUsdg(uint256 amount6) internal {
        deal(AddressBook.USDG, address(fund), amount6);
    }

    function test_manager_compra_TSLA_por_uniswap_v4_real() public {
        _fundHasUsdg(5000_000000);
        assertEq(IERC20(AddressBook.USDG).balanceOf(address(fund)), 5000_000000);

        // el manager compra ~1000 USDG de TSLA (USDG = currency1 → zeroForOne=false)
        vm.prank(manager);
        fund.execute(adapterId, AddressBook.USDG, AddressBook.TSLA, 1000_000000, _poolKey());

        uint256 tslaBal = IERC20(AddressBook.TSLA).balanceOf(address(fund));
        assertGt(tslaBal, 0, "el fondo recibio TSLA");
        assertEq(IERC20(AddressBook.USDG).balanceOf(address(fund)), 4000_000000, "gasto exactamente 1000 USDG");
        assertEq(fund.assetCount(), 1, "TSLA registrado en cartera");

        // NAV coherente: ~5000 (el swap es casi neutro en valor, menos el fee del pool)
        uint256 navWad = fund.nav().navWad;
        assertApproxEqRel(navWad, 5000e18, 0.02e18, "NAV se conserva (~5000, menos fee del pool)");
        console2.log("TSLA comprado (18 dec):", tslaBal);
        console2.log("NAV tras el trade (WAD):", navWad);
    }

    function test_slippage_guardrail_rechaza_amount_absurdo() public {
        _fundHasUsdg(5000_000000);
        // comprar un tamaño enorme mueve mucho el pool → slippage > 1% vs oráculo → revierte
        vm.prank(manager);
        vm.expectRevert(); // SlippageExceeded o BudgetExceeded
        fund.execute(adapterId, AddressBook.USDG, AddressBook.TSLA, 4000_000000, _poolKey());
    }

    function test_round_trip_y_freeze_pre_settlement() public {
        _fundHasUsdg(5000_000000);
        vm.prank(manager);
        fund.execute(adapterId, AddressBook.USDG, AddressBook.TSLA, 500_000000, _poolKey());
        uint256 tsla = IERC20(AddressBook.TSLA).balanceOf(address(fund));

        // vender la mitad de vuelta (dentro de tolerancia, sin wash — distinto par de dirección)
        vm.prank(manager);
        fund.execute(adapterId, AddressBook.TSLA, AddressBook.USDG, tsla / 2, _poolKey());
        assertGt(IERC20(AddressBook.USDG).balanceOf(address(fund)), 4500_000000, "recupero USDG");

        // trading congelado cuando el settlement está due
        vm.warp(block.timestamp + 30 days + 1);
        vm.prank(manager);
        vm.expectRevert(Fund.FrozenFund.selector);
        fund.execute(adapterId, AddressBook.USDG, AddressBook.TSLA, 100_000000, _poolKey());
    }
}
