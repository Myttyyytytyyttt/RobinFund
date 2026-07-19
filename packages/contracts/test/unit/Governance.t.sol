// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {EligibilityGate} from "../../src/EligibilityGate.sol";
import {Guardian} from "../../src/Guardian.sol";
import {FeeSplitter} from "../../src/FeeSplitter.sol";
import {FundFactory} from "../../src/FundFactory.sol";
import {Fund} from "../../src/Fund.sol";
import {TokenRegistry} from "../../src/TokenRegistry.sol";
import {AdapterRegistry} from "../../src/AdapterRegistry.sol";
import {IEligibilityGate} from "../../src/interfaces/IEligibilityGate.sol";
import {IERC20} from "../../src/interfaces/IERC20.sol";
import {MockAccessRegistry, MockStockToken, MockUSDG, MockFeed} from "../mocks/Mocks.sol";

contract EligibilityGateTest is Test {
    EligibilityGate gate;
    uint256 signerPk = 0xA11CE;
    address signer;
    address alice = address(0xA1);

    function setUp() public {
        vm.warp(100_000_000);
        signer = vm.addr(signerPk);
        gate = new EligibilityGate(signer);
    }

    function _sign(address account, uint48 expiry, uint256 nonce) internal view returns (bytes memory) {
        bytes32 structHash = keccak256(abi.encode(gate.ATTESTATION_TYPEHASH(), account, expiry, nonce));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", gate.DOMAIN_SEPARATOR(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(signerPk, digest);
        return abi.encodePacked(r, s, v);
    }

    function test_attest_valido() public {
        uint48 expiry = uint48(block.timestamp + 90 days);
        gate.attest(alice, expiry, 0, _sign(alice, expiry, 0));
        assertTrue(gate.isEligible(alice));
        assertEq(gate.ineligibleSince(alice), 0);
    }

    function test_firma_de_otro_rechazada() public {
        uint48 expiry = uint48(block.timestamp + 90 days);
        // firma con una PK que no es el signer
        bytes32 structHash = keccak256(abi.encode(gate.ATTESTATION_TYPEHASH(), alice, expiry, uint256(0)));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", gate.DOMAIN_SEPARATOR(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(0xBAD, digest);
        vm.expectRevert(EligibilityGate.BadSignature.selector);
        gate.attest(alice, expiry, 0, abi.encodePacked(r, s, v));
    }

    function test_replay_por_nonce_rechazado() public {
        uint48 expiry = uint48(block.timestamp + 90 days);
        bytes memory sig = _sign(alice, expiry, 0);
        gate.attest(alice, expiry, 0, sig);
        vm.expectRevert(EligibilityGate.BadNonce.selector); // el nonce ya avanzó a 1
        gate.attest(alice, expiry, 0, sig);
    }

    function test_caducidad_da_ineligibleSince() public {
        uint48 expiry = uint48(block.timestamp + 10 days);
        gate.attest(alice, expiry, 0, _sign(alice, expiry, 0));
        vm.warp(expiry + 1);
        assertFalse(gate.isEligible(alice));
        assertEq(gate.ineligibleSince(alice), expiry);
    }

    function test_revocacion() public {
        uint48 expiry = uint48(block.timestamp + 90 days);
        gate.attest(alice, expiry, 0, _sign(alice, expiry, 0));
        vm.prank(signer);
        gate.revoke(alice);
        assertFalse(gate.isEligible(alice));
        assertEq(gate.ineligibleSince(alice), uint48(block.timestamp));
    }

    function test_nunca_atestado_no_elegible_sin_ineligibleSince() public view {
        assertFalse(gate.isEligible(alice));
        assertEq(gate.ineligibleSince(alice), 0); // no puede forzarse su redención (no tiene shares)
    }

    // G1 (HIGH): una firma pre-emitida NO puede deshacer una revocación
    function test_G1_revocacion_no_evadible_por_firma_previa() public {
        uint48 expiry = uint48(block.timestamp + 90 days);
        // el signer pre-firma una atestación (renovación entregada off-chain) al nonce 0
        bytes memory preSigned = _sign(alice, expiry, 0);
        gate.attest(alice, expiry, 0, preSigned); // alice se atesta → nonce ahora 1

        // el signer firma la SIGUIENTE renovación por adelantado (nonce 1), aún no enviada
        bytes memory preSignedRenewal = _sign(alice, uint48(block.timestamp + 180 days), 1);

        // evento de compliance: el signer revoca (nonce avanza a 2)
        vm.prank(signer);
        gate.revoke(alice);
        assertFalse(gate.isEligible(alice));

        // alice intenta re-habilitarse con la renovación pre-firmada (nonce 1): DEBE fallar
        vm.expectRevert(EligibilityGate.BadNonce.selector);
        gate.attest(alice, uint48(block.timestamp + 180 days), 1, preSignedRenewal);
        assertFalse(gate.isEligible(alice), "la revocacion aguanta");

        // re-habilitar exige que el signer firme el nonce NUEVO (2) tras la revocación
        uint48 exp2 = uint48(block.timestamp + 90 days);
        gate.attest(alice, exp2, 2, _sign(alice, exp2, 2));
        assertTrue(gate.isEligible(alice));
    }
}

contract GuardianTest is Test {
    Guardian guardian;
    TokenRegistry reg;
    MockUSDG usdg;
    address multisig = address(0x5AFE);

    function setUp() public {
        vm.warp(100_000_000);
        usdg = new MockUSDG();
        guardian = new Guardian(multisig, 2 days);
        reg = new TokenRegistry(address(usdg));
        reg.transferOwnership(address(guardian));
        // el guardian acepta la ownership via una llamada timelockeada... o directa (acceptOwnership no es onlyOwner del registry)
    }

    function test_timelock_gestiona_registry() public {
        // aceptar ownership del registry (llamada sin timelock del guardian: es de bajo riesgo, pero
        // la enrutamos por el timelock para probar el flujo completo)
        bytes memory data = abi.encodeWithSignature("acceptOwnership()");
        vm.prank(multisig);
        guardian.queue(address(reg), 0, data);

        // antes del delay: no ejecutable
        vm.prank(multisig);
        vm.expectRevert(abi.encodeWithSelector(Guardian.TimelockActive.selector, block.timestamp + 2 days));
        guardian.execute(address(reg), 0, data);

        vm.warp(block.timestamp + 2 days);
        vm.prank(multisig);
        guardian.execute(address(reg), 0, data);
        assertEq(reg.owner(), address(guardian), "el guardian es owner del registry");
    }

    function test_solo_owner() public {
        vm.expectRevert(Guardian.NotOwner.selector);
        guardian.queue(address(reg), 0, "");
    }

    // G2: una acción encolada caduca tras DELAY + GRACE_PERIOD
    function test_G2_accion_caduca() public {
        bytes memory data = abi.encodeWithSignature("acceptOwnership()");
        vm.prank(multisig);
        guardian.queue(address(reg), 0, data);
        vm.warp(block.timestamp + 2 days + 14 days + 1);
        vm.prank(multisig);
        vm.expectRevert(abi.encodeWithSelector(Guardian.Stale.selector, block.timestamp - 1));
        guardian.execute(address(reg), 0, data);
    }

    function test_G2_delay_minimo() public {
        vm.expectRevert(Guardian.BadDelay.selector);
        new Guardian(multisig, 12 hours);
    }
}

contract FactoryE2ETest is Test {
    MockAccessRegistry access;
    MockStockToken tsla;
    MockUSDG usdg;
    MockFeed feed;
    EligibilityGate gate;
    Guardian guardian;
    TokenRegistry reg;
    AdapterRegistry adapters;
    FundFactory factory;

    uint256 signerPk = 0x516;
    address signer;
    address manager = address(0x4A4A);
    address keeper = address(0x6E6E);
    address treasury = address(0x7EA5);
    address multisig = address(0x5AFE);

    function setUp() public {
        vm.warp(100_000_000);
        signer = vm.addr(signerPk);
        access = new MockAccessRegistry();
        tsla = new MockStockToken("TSLA", access);
        usdg = new MockUSDG();
        feed = new MockFeed(100_00000000);
        gate = new EligibilityGate(signer);
        guardian = new Guardian(multisig, 2 days);
        reg = new TokenRegistry(address(usdg));
        reg.list(address(tsla), address(feed), 90000, 1_00000000, 10000_00000000, address(0xBEEF));
        adapters = new AdapterRegistry();
        factory = new FundFactory(reg, adapters, IEligibilityGate(address(gate)), address(guardian), keeper, treasury);
    }

    function _attest(address a) internal {
        uint48 exp = uint48(block.timestamp + 90 days);
        bytes32 sh = keccak256(abi.encode(gate.ATTESTATION_TYPEHASH(), a, exp, uint256(0)));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", gate.DOMAIN_SEPARATOR(), sh));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(signerPk, digest);
        gate.attest(a, exp, 0, abi.encodePacked(r, s, v));
    }

    function test_factory_gatea_manager_inelegible() public {
        Fund.Config memory cfg = Fund.Config({perfFeeBps: 2000, feeMinBps: 0, feeMaxBps: 0, managerEntryShareBps: 5000, kFactor: 25, period: 30 days, withdrawCooldown: 24 hours});
        vm.prank(manager);
        vm.expectRevert(FundFactory.NotEligible.selector);
        factory.createFund(cfg, "RF", "RF");
    }

    function test_e2e_crear_fondo_depositar_y_pausar() public {
        _attest(manager);
        address alice = address(0xA11CE);
        _attest(alice);

        Fund.Config memory cfg = Fund.Config({perfFeeBps: 2000, feeMinBps: 0, feeMaxBps: 0, managerEntryShareBps: 5000, kFactor: 25, period: 30 days, withdrawCooldown: 24 hours});
        vm.prank(manager);
        Fund fund = Fund(factory.createFund(cfg, "RobinFund Alpha", "rfA"));

        assertEq(factory.fundCount(), 1);
        assertTrue(factory.isFund(address(fund)));
        assertEq(fund.MANAGER(), manager);
        assertEq(fund.GUARDIAN(), address(guardian));
        assertTrue(fund.FEE_SPLITTER() != address(0), "FeeSplitter desplegado internamente");

        // stake
        usdg.mint(manager, 2000_000000);
        vm.startPrank(manager);
        usdg.approve(address(fund.stakeEscrow()), 2000_000000);
        fund.stakeEscrow().addStake(2000_000000);
        vm.stopPrank();

        // depósito de alice
        usdg.mint(alice, 1000_000000);
        vm.startPrank(alice);
        usdg.approve(address(fund), 1000_000000);
        fund.requestDeposit(1000_000000);
        vm.stopPrank();
        vm.warp(block.timestamp + 11 minutes);
        feed.set(feed.answer(), block.timestamp);
        fund.executeBatch(0);
        assertGt(fund.share().balanceOf(alice), 0, "alice tiene shares via factory-fund");

        // el guardian pausa depósitos (circuit breaker); los retiros siguen abiertos (D12)
        vm.prank(multisig);
        guardian.pauseFund(address(fund));
        assertTrue(fund.guardianPaused());

        usdg.mint(alice, 500_000000);
        vm.startPrank(alice);
        usdg.approve(address(fund), 500_000000);
        vm.expectRevert(Fund.FrozenFund.selector);
        fund.requestDeposit(500_000000); // depósito bloqueado
        // pero retirar sí se puede
        fund.requestWithdraw(fund.share().balanceOf(alice), true);
        vm.stopPrank();

        // el guardian reanuda
        vm.prank(multisig);
        guardian.unpauseFund(address(fund));
        assertFalse(fund.guardianPaused());
    }

    function test_pause_solo_guardian() public {
        _attest(manager);
        Fund.Config memory cfg = Fund.Config({perfFeeBps: 2000, feeMinBps: 0, feeMaxBps: 0, managerEntryShareBps: 5000, kFactor: 25, period: 30 days, withdrawCooldown: 24 hours});
        vm.prank(manager);
        Fund fund = Fund(factory.createFund(cfg, "RF", "RF"));
        vm.prank(address(0xBAD));
        vm.expectRevert(Fund.NotGuardian.selector);
        fund.setGuardianPaused(true);
    }
}
