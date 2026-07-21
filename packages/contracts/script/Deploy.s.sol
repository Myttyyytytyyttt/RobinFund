// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script, console2} from "forge-std/Script.sol";
import {TokenRegistry} from "../src/TokenRegistry.sol";
import {AdapterRegistry} from "../src/AdapterRegistry.sol";
import {OpenEligibilityGate} from "../src/OpenEligibilityGate.sol";
import {Guardian} from "../src/Guardian.sol";
import {FundRegistry} from "../src/FundRegistry.sol";
import {UniswapV4Adapter, IPoolManager} from "../src/adapters/UniswapV4Adapter.sol";
import {AddressBook} from "../src/AddressBook.sol";
import {IBeacon} from "../src/interfaces/IAggregatorV3.sol";

/// @title Deploy — despliega el protocolo compartido de RobinFund (SPEC §12)
/// @notice Orden: registries → gate abierto → guardian → adapter → registry. Después transfiere la ownership
/// de los registries al Guardian y lista los Stock Tokens iniciales. Parametrizable por env:
///   DEPLOYER_PK, GUARDIAN_MULTISIG, GUARDIAN_DELAY.
/// Uso: forge script script/Deploy.s.sol --rpc-url robinhood_testnet --broadcast
contract Deploy is Script {
    // maxStaleness por activo (heartbeat real 86400s + 1h de margen); bandas amplias iniciales.
    uint48 constant STALENESS = 90000;

    function run() external {
        uint256 deployerPk = vm.envUint("DEPLOYER_PK");
        address multisig = vm.envOr("GUARDIAN_MULTISIG", vm.addr(deployerPk));
        uint256 guardianDelay = vm.envOr("GUARDIAN_DELAY", uint256(2 days));

        // La clave llega por el entorno, nunca como argumento visible del proceso `forge`.
        vm.startBroadcast(deployerPk);

        TokenRegistry registry = new TokenRegistry(AddressBook.USDG);
        AdapterRegistry adapters = new AdapterRegistry();
        OpenEligibilityGate gate = new OpenEligibilityGate();
        Guardian guardian = new Guardian(multisig, guardianDelay);
        UniswapV4Adapter uniAdapter = new UniswapV4Adapter(IPoolManager(AddressBook.UNI_V4_POOL_MANAGER));
        uint256 adapterId = adapters.add(address(uniAdapter));

        FundRegistry fundRegistry = new FundRegistry();

        // Feed USDG/USD (§5.5) y activos iniciales. La impl del beacon se lee en vivo (commit exacto, F5).
        registry.setUsdgFeed(AddressBook.USDG_FEED, STALENESS, 90000000, 110000000);
        address impl = IBeacon(AddressBook.ACCESS_REGISTRY).implementation();
        _list(registry, AddressBook.TSLA, AddressBook.TSLA_FEED, impl);
        _list(registry, AddressBook.NVDA, AddressBook.NVDA_FEED, impl);
        _list(registry, AddressBook.AAPL, AddressBook.AAPL_FEED, impl);
        _list(registry, AddressBook.MSFT, AddressBook.MSFT_FEED, impl);
        _list(registry, AddressBook.SPY, AddressBook.SPY_FEED, impl);

        // Gobernanza: los registries pasan a ser propiedad del Guardian (timelock).
        registry.transferOwnership(address(guardian));
        adapters.transferOwnership(address(guardian));
        // acceptOwnership lo ejecuta el Guardian vía queue/execute tras el delay (post-deploy).

        vm.stopBroadcast();

        console2.log("TokenRegistry   ", address(registry));
        console2.log("AdapterRegistry ", address(adapters));
        console2.log("OpenEligibilityGate", address(gate));
        console2.log("Guardian        ", address(guardian));
        console2.log("UniswapV4Adapter", address(uniAdapter), "id", adapterId);
        console2.log("FundRegistry    ", address(fundRegistry));
    }

    /// @dev Banda de cordura amplia inicial ($1–$100k); se ajusta por activo en operación.
    function _list(TokenRegistry registry, address token, address feed, address impl) internal {
        registry.list(token, feed, STALENESS, 1_00000000, 100_000_00000000, impl);
    }
}
