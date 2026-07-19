// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {AddressBook} from "../../src/AddressBook.sol";
import {IStockToken, IAccessControlledRegistry} from "../../src/interfaces/IStockToken.sol";
import {IERC20} from "../../src/interfaces/IERC20.sol";

/// @notice Contrato mínimo que custodia Stock Tokens — prueba la tesis central:
/// un contrato arbitrario no whitelisteado puede recibir, mantener y mover Stock Tokens.
contract CustodyProbe {
    function sweep(IERC20 token, address to) external {
        token.transfer(to, token.balanceOf(address(this)));
    }
}

/// @notice Smoke test de Fase 0 contra el estado REAL de Robinhood Chain (fork).
/// Ejecutar: forge test --match-path "test/fork/*" (necesita RH_RPC_MAINNET en el entorno)
contract ForkSmokeTest is Test {
    IStockToken tsla = IStockToken(AddressBook.TSLA);
    IERC20 usdg = IERC20(AddressBook.USDG);
    IAccessControlledRegistry registry = IAccessControlledRegistry(AddressBook.ACCESS_REGISTRY);

    // El address dead acumula TSLA quemado "a mano" por usuarios — sirve de donante impersonable.
    address constant DONOR = 0x000000000000000000000000000000000000dEaD;

    function setUp() public {
        vm.createSelectFork(vm.envString("RH_RPC_MAINNET"));
    }

    function test_chain_y_unidades() public view {
        assertEq(block.chainid, 4663, "chain id");
        assertEq(usdg.decimals(), 6, "USDG debe tener 6 decimales (SPEC 3.1)");
        assertEq(tsla.decimals(), 18, "Stock Tokens 18 dec");
        assertGe(tsla.uiMultiplier(), 1e18, "multiplicador >= 1.0");
    }

    function test_punteros_y_estados_de_pausa() public view {
        assertEq(tsla.ACCESS_CONTROLLED_REGISTRY(), AddressBook.ACCESS_REGISTRY, "puntero registry");
        assertFalse(tsla.tokenPaused(), "token no pausado");
        assertFalse(tsla.oraclePaused(), "oraculo no pausado");
        assertFalse(registry.paused(), "registry no pausado");
    }

    function test_un_contrato_puede_custodiar_stock_tokens() public {
        CustodyProbe probe = new CustodyProbe();

        // Un contrato recien desplegado no esta bloqueado (blacklist default-allow, sin allowlist).
        assertFalse(registry.isBlocked(address(probe)), "probe no bloqueado");

        // Mover TSLA real: donante -> contrato nuestro -> fuera. Si esto pasa, la tesis del proyecto es viable.
        uint256 amt = tsla.balanceOf(DONOR);
        assertGt(amt, 0, "el donante tiene TSLA");

        vm.prank(DONOR);
        assertTrue(tsla.transfer(address(probe), amt), "transfer al contrato");
        assertEq(tsla.balanceOf(address(probe)), amt, "el contrato custodia TSLA");

        probe.sweep(IERC20(address(tsla)), address(0xBEEF));
        assertEq(tsla.balanceOf(address(0xBEEF)), amt, "el contrato puede mover lo que custodia");
    }
}
