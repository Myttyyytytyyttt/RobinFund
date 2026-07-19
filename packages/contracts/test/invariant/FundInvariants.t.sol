// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {Fund} from "../../src/Fund.sol";
import {TokenRegistry} from "../../src/TokenRegistry.sol";
import {AdapterRegistry} from "../../src/AdapterRegistry.sol";
import {IEligibilityGate} from "../../src/interfaces/IEligibilityGate.sol";
import {MockAccessRegistry, MockStockToken, MockUSDG, MockFeed, MockGate} from "../mocks/Mocks.sol";

/// @notice Handler: LPs aleatorios depositan/retiran/reclaman y el keeper settlea, con precio de
/// TSLA moviéndose arbitrariamente. Verifica los invariantes NI de la spec sobre el CÓDIGO.
contract FundHandler is Test {
    Fund public fund;
    MockUSDG usdg;
    MockStockToken tsla;
    MockFeed feed;
    MockGate gate;
    address keeper;
    address[] public lps;

    // acumuladores para invariantes de por vida
    mapping(address => uint256) public contributed6; // Σ cash aportado
    mapping(address => uint256) public claimed6; // Σ claims cobrados

    constructor(Fund f, MockUSDG u, MockStockToken t, MockFeed fe, MockGate g, address k) {
        fund = f;
        usdg = u;
        tsla = t;
        feed = fe;
        gate = g;
        keeper = k;
        for (uint160 i = 1; i <= 5; ++i) {
            lps.push(address(uint160(0xA000 + i)));
        }
    }

    function _lp(uint256 seed) internal view returns (address) {
        return lps[seed % lps.length];
    }

    function deposit(uint256 lpSeed, uint256 amount) public {
        if (fund.state() != Fund.State.Active || fund.frozen()) return;
        address lp = _lp(lpSeed);
        amount = 50_000000 + (amount % 5000_000000);
        if (fund.pendingOrders(lp) >= 8) return;
        usdg.mint(lp, amount);
        vm.startPrank(lp);
        usdg.approve(address(fund), amount);
        try fund.requestDeposit(amount) {
            contributed6[lp] += amount;
        } catch {}
        vm.stopPrank();
    }

    function withdraw(uint256 lpSeed, uint256 shareFrac, bool inKind) public {
        address lp = _lp(lpSeed);
        uint256 bal = fund.share().balanceOf(lp) - fund.lockedShares(lp);
        if (bal == 0 || fund.pendingOrders(lp) >= 8) return;
        uint256 shares = 1 + (shareFrac % bal);
        vm.prank(lp);
        try fund.requestWithdraw(shares, inKind) {} catch {}
    }

    function movePrice(uint256 p) public {
        int256 px = int256(10_00000000 + (p % 990_00000000)); // $10–$1000
        feed.set(px, block.timestamp);
    }

    function warpAndBatch(uint256 dt) public {
        vm.warp(block.timestamp + 11 minutes + (dt % 20 days));
        feed.set(feed.answer(), block.timestamp);
        try fund.executeBatch(0) {} catch {}
    }

    function settleAndClaim(uint256 lpSeed, uint256 grossHint) public {
        feed.set(feed.answer(), block.timestamp);
        if (block.timestamp >= fund.settlementDue() && fund.state() != Fund.State.Closed) {
            // grossClaims honesto sería costoso de recomputar aquí; usamos un valor alto seguro:
            // el contrato hace min(stake, netted, gross), así que un gross grande no rompe nada.
            vm.prank(keeper);
            try fund.settle(grossHint % 1e30) {} catch {}
        }
        address lp = _lp(lpSeed);
        uint256 before = usdg.balanceOf(lp);
        try fund.claim() {} catch {}
        // claim() no cobra directamente al caller salvo que sea el lp; hacemos claim como el lp
        vm.prank(lp);
        try fund.claim() {} catch {}
        claimed6[lp] += usdg.balanceOf(lp) - before;
    }

    function lpCount() external view returns (uint256) {
        return lps.length;
    }
}

contract FundInvariantsTest is Test {
    Fund fund;
    MockUSDG usdg;
    MockStockToken tsla;
    MockFeed feed;
    MockGate gate;
    MockAccessRegistry access;
    TokenRegistry reg;
    FundHandler handler;
    address keeper = address(0x6E6E);
    address feeSplitter = address(0xFEE5);

    function setUp() public {
        vm.warp(100_000_000);
        access = new MockAccessRegistry();
        tsla = new MockStockToken("TSLA", access);
        usdg = new MockUSDG();
        feed = new MockFeed(100_00000000);
        gate = new MockGate();
        reg = new TokenRegistry(address(usdg));
        reg.list(address(tsla), address(feed), 90000, 1_00000000, 10000_00000000, address(0xBEEF));

        AdapterRegistry adapters = new AdapterRegistry();
        fund = new Fund(
            reg,
            IEligibilityGate(address(gate)),
            adapters,
            address(0x4A4A),
            keeper,
            feeSplitter,
            address(0x7EA5),
            Fund.Config({
                perfFeeBps: 2000,
                feeMinBps: 0,
                feeMaxBps: 200,
                managerEntryShareBps: 5000,
                kFactor: 25,
                period: 30 days,
                withdrawCooldown: 24 hours
            }),
            "Inv",
            "INV"
        );
        // stake generoso para que el fondo acepte depósitos
        usdg.mint(address(0x4A4A), 100_000_000000);
        vm.startPrank(address(0x4A4A));
        usdg.approve(address(fund.stakeEscrow()), 100_000_000000);
        fund.stakeEscrow().addStake(100_000_000000);
        vm.stopPrank();

        handler = new FundHandler(fund, usdg, tsla, feed, gate, keeper);
        targetContract(address(handler));
    }

    /// @notice Invariante de caja de la reserva: nunca paga más de lo fondeado por período.
    function invariant_reserveSolvente() public view {
        // totalPaid ≤ totalFunded, garantizado por el contrato; comprobamos que la caja lo respalda
        uint256 bal = usdg.balanceOf(address(fund.reserve()));
        uint256 owed = fund.reserve().totalFunded() - fund.reserve().totalPaid();
        assertGe(bal, owed, "la reserva siempre cubre lo fondeado no pagado");
    }

    /// @notice NI agregado ≡ Σ NI_lp (excluyendo FeeSplitter).
    function invariant_niAgregadoConsistente() public {
        int256 sum;
        uint256 n = handler.lpCount();
        for (uint256 i; i < n; ++i) {
            sum += fund.accountOf(handler.lps(i)).niWad;
        }
        assertEq(sum, fund.niAggregateWad(), "NI agregado = suma per-LP");
    }

    /// @notice Σ claims de por vida de un LP ≤ capital neto aportado (invariante 2, §6).
    function invariant_claimsNoExcedenAportado() public view {
        uint256 n = handler.lpCount();
        for (uint256 i; i < n; ++i) {
            address lp = handler.lps(i);
            assertLe(handler.claimed6(lp), handler.contributed6(lp), "claims de por vida <= aportado");
        }
    }

    /// @notice El USDG en el QueueEscrow siempre iguala los depósitos vivos contabilizados.
    function invariant_queueEscrowCuadra() public view {
        assertEq(usdg.balanceOf(address(fund.queue())), fund.queuedDeposits6(), "escrow = depositos vivos");
    }
}
