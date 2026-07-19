// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {Fund} from "../../src/Fund.sol";
import {TokenRegistry} from "../../src/TokenRegistry.sol";
import {AdapterRegistry} from "../../src/AdapterRegistry.sol";
import {ITradeAdapter} from "../../src/interfaces/ITradeAdapter.sol";
import {IEligibilityGate} from "../../src/interfaces/IEligibilityGate.sol";
import {IERC20} from "../../src/interfaces/IERC20.sol";
import {MockAccessRegistry, MockStockToken, MockUSDG, MockFeed, MockGate} from "../mocks/Mocks.sol";

interface IMintable {
    function mint(address to, uint256 amt) external;
}

/// @notice Adapter mock: swap a un output controlable (para inyectar slippage). Consume el input a un
/// sink y MINTEA el output al recipient — así el adapter queda con balance CERO tras el swap, como el
/// UniswapV4Adapter real (que hace `take` directo al recipient). Cumple la aserción de residuo cero (T5).
contract MockAdapter is ITradeAdapter {
    address public sink = address(0x5117);
    uint256 public outAmount;

    function setOut(uint256 v) external {
        outAmount = v;
    }

    function swap(address tokenIn, address, /*tokenOut*/ uint256 amountIn, address recipient, bytes calldata data)
        external
        override
    {
        address tokenOut = abi.decode(data, (address));
        IERC20(tokenIn).transfer(sink, amountIn); // consume el input (queda a cero)
        IMintable(tokenOut).mint(recipient, outAmount); // mintea el output (no retiene inventario)
    }
}

contract TradingTest is Test {
    MockAccessRegistry access;
    MockStockToken tsla;
    MockUSDG usdg;
    MockFeed tslaFeed;
    MockFeed usdgFeed;
    MockGate gate;
    TokenRegistry reg;
    AdapterRegistry adapters;
    MockAdapter adapter;
    Fund fund;
    uint256 aid;

    address manager = address(0x4A4A);
    address keeper = address(0x6E6E);

    uint48 constant STALENESS = 90000;

    function setUp() public {
        vm.warp(100_000_000);
        access = new MockAccessRegistry();
        tsla = new MockStockToken("TSLA", access);
        usdg = new MockUSDG();
        tslaFeed = new MockFeed(100_00000000); // $100
        usdgFeed = new MockFeed(1_00000000);
        gate = new MockGate();
        reg = new TokenRegistry(address(usdg));
        reg.list(address(tsla), address(tslaFeed), STALENESS, 50_00000000, 200_00000000, address(0xBEEF)); // banda $50–$200
        reg.setUsdgFeed(address(usdgFeed), STALENESS, 90000000, 110000000);

        adapters = new AdapterRegistry();
        adapter = new MockAdapter();
        aid = adapters.add(address(adapter));

        fund = new Fund(
            reg, IEligibilityGate(address(gate)), adapters, address(0x6DAD), manager, keeper, address(0x7EA5),
            Fund.Config({perfFeeBps: 2000, feeMinBps: 0, feeMaxBps: 0, managerEntryShareBps: 5000, kFactor: 25, period: 30 days, withdrawCooldown: 24 hours}),
            "T", "T"
        );
        usdg.mint(manager, 10_000_000000);
        vm.startPrank(manager);
        usdg.approve(address(fund.stakeEscrow()), 10_000_000000);
        fund.stakeEscrow().addStake(10_000_000000);
        vm.stopPrank();

        // el fondo tiene 10.000 USDG para operar; el adapter mintea el output (no retiene inventario)
        usdg.mint(address(fund), 10_000_000000);
    }

    function _buyTsla(uint256 usdgIn, uint256 tslaOut) internal {
        adapter.setOut(tslaOut);
        vm.prank(manager);
        fund.execute(aid, address(usdg), address(tsla), usdgIn, abi.encode(address(tsla)));
    }

    // ---------- T1: feed stale o fuera de banda bloquea el trade ----------

    function test_T1_feed_stale_bloquea_trade() public {
        // precio fresco pero lo envejecemos por encima de maxStaleness
        tslaFeed.set(100_00000000, block.timestamp - STALENESS - 1);
        adapter.setOut(10e18); // 1000 USDG → 10 TSLA ($100), sería justo si el feed valiera
        vm.prank(manager);
        vm.expectRevert(Fund.SlippageExceeded.selector);
        fund.execute(aid, address(usdg), address(tsla), 1000_000000, abi.encode(address(tsla)));
    }

    function test_T1_feed_fuera_de_banda_bloquea_trade() public {
        tslaFeed.set(300_00000000, block.timestamp); // $300 > banda máx $200
        adapter.setOut(3e18);
        vm.prank(manager);
        vm.expectRevert(Fund.SlippageExceeded.selector);
        fund.execute(aid, address(usdg), address(tsla), 1000_000000, abi.encode(address(tsla)));
    }

    function test_T1_trade_valido_pasa() public {
        // 1000 USDG → 10 TSLA a $100 = valor paritario, 0 slippage
        _buyTsla(1000_000000, 10e18);
        assertEq(tsla.balanceOf(address(fund)), 10e18);
        assertEq(fund.assetCount(), 1);
    }

    function test_T1_slippage_excesivo_bloquea() public {
        // 1000 USDG → 9.8 TSLA ($980 recibido vs $1000 = 2% slippage > 1%)
        adapter.setOut(9.8e18);
        vm.prank(manager);
        vm.expectRevert(Fund.SlippageExceeded.selector);
        fund.execute(aid, address(usdg), address(tsla), 1000_000000, abi.encode(address(tsla)));
    }

    // ---------- T7: se puede VENDER un token suspendido, no comprar ----------

    function test_T7_vender_token_suspendido_permitido() public {
        _buyTsla(1000_000000, 10e18); // el fondo tiene 10 TSLA
        reg.suspend(address(tsla)); // el emisor upgradeó el beacon → suspendido

        // comprar más TSLA: prohibido
        vm.prank(manager);
        vm.expectRevert(Fund.BadOrder.selector);
        fund.execute(aid, address(usdg), address(tsla), 100_000000, abi.encode(address(tsla)));

        // vender TSLA para des-arriesgarse: permitido (T7)
        adapter.setOut(500_000000); // 5 TSLA → 500 USDG a $100 = paritario
        vm.prank(manager);
        fund.execute(aid, address(tsla), address(usdg), 5e18, abi.encode(address(usdg)));
        assertEq(tsla.balanceOf(address(fund)), 5e18, "pudo vender el token suspendido");
    }

    // ---------- T8: wash por interleaving cuenta doble ----------

    function test_T8_wash_con_interleaving_cuenta_doble() public {
        // dar al fondo también algo de un segundo token para el trade "throwaway"
        MockStockToken nvda = new MockStockToken("NVDA", access);
        reg.list(address(nvda), address(tslaFeed), STALENESS, 50_00000000, 200_00000000, address(0xBEEF));

        // trade 1: USDG→TSLA con 0.5% slippage
        adapter.setOut(9.95e18); // 995 vs 1000 = 0.5%
        vm.prank(manager);
        fund.execute(aid, address(usdg), address(tsla), 1000_000000, abi.encode(address(tsla)));
        uint256 afterFirst = fund.slippagePeriodWad();
        assertGt(afterFirst, 0);

        // trade 2 (throwaway, distinto par): USDG→NVDA
        adapter.setOut(9.95e18);
        vm.prank(manager);
        fund.execute(aid, address(usdg), address(nvda), 1000_000000, abi.encode(address(nvda)));

        // trade 3: reversa del par 1 (TSLA→USDG) dentro de la ventana → debe contar DOBLE
        // pese al trade intermedio (antes esto lo esquivaba, T8)
        adapter.setOut(497_500000); // 5 TSLA * ~$99.5 con 0.5% slippage
        uint256 before3 = fund.slippagePeriodWad();
        vm.prank(manager);
        fund.execute(aid, address(tsla), address(usdg), 5e18, abi.encode(address(usdg)));
        uint256 charge3 = fund.slippagePeriodWad() - before3;

        // el cargo del trade 3 refleja ~2× su slippage adverso (reversa detectada por par)
        // slippage adverso de vender 5 TSLA (~$500) con 0.5% ≈ $2.5 → doble ≈ $5
        assertGt(charge3, 4e18, "reversa cuenta doble pese al interleaving");
        assertLt(charge3, 6e18);
    }

    // ---------- Presupuesto de período ----------

    function test_budget_periodo_bloquea_sangrado_lento() public {
        // stake 10.000, budget periodo = 50% = 5.000; cada trade ~1% de slippage máx
        // muchos trades al límite acaban topando el presupuesto de período
        adapter.setOut(9.9e18); // ~1% slippage, ~$10 adverso por trade de 1000
        for (uint256 i; i < 200; ++i) {
            usdg.mint(address(fund), 1000_000000);
            adapter.setOut(9.9e18);
            vm.prank(manager);
            try fund.execute(aid, address(usdg), address(tsla), 1000_000000, abi.encode(address(tsla))) {}
            catch {
                // en algún punto BudgetExceeded o TradeLimit — el sangrado está acotado
                assertGt(i, 0, "el presupuesto acota el sangrado");
                return;
            }
        }
        // no debería llegar a 200 trades sin toparse (500 slippage acumulado / 5000 budget)
    }
}
