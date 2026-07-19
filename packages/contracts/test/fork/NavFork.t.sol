// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test, console2} from "forge-std/Test.sol";
import {AddressBook} from "../../src/AddressBook.sol";
import {TokenRegistry} from "../../src/TokenRegistry.sol";
import {NAVLib} from "../../src/libraries/NAVLib.sol";
import {IAggregatorV3} from "../../src/interfaces/IAggregatorV3.sol";
import {IERC20} from "../../src/interfaces/IERC20.sol";

contract NavHarnessFork {
    function compute(TokenRegistry reg, address fund, address[] memory tokens)
        external
        view
        returns (NAVLib.Snapshot memory)
    {
        return NAVLib.compute(reg, fund, tokens);
    }
}

/// @notice NAVLib + TokenRegistry contra los contratos y feeds REALES de chain 4663.
contract NavForkTest is Test {
    uint48 constant STALENESS = 90000; // heartbeat real 86400 + 1h (Fase 0.4.3)
    address constant HOLDER = 0x000000000000000000000000000000000000dEaD;

    TokenRegistry reg;
    NavHarnessFork nav;

    function setUp() public {
        vm.createSelectFork(vm.envString("RH_RPC_MAINNET"));
        reg = new TokenRegistry(AddressBook.USDG);
        reg.list(AddressBook.TSLA, AddressBook.TSLA_FEED, STALENESS);
        reg.list(AddressBook.NVDA, AddressBook.NVDA_FEED, STALENESS);
        reg.setUsdgFeed(AddressBook.USDG_FEED, STALENESS);
        nav = new NavHarnessFork();
    }

    function test_list_contra_tokens_reales() public view {
        TokenRegistry.Asset memory a = reg.getAsset(AddressBook.TSLA);
        assertEq(a.beacon, AddressBook.ACCESS_REGISTRY, "beacon real capturado");
        assertTrue(a.implAtListing != address(0), "impl real capturada");
        assertEq(address(reg.accessRegistry()), AddressBook.ACCESS_REGISTRY);
    }

    function test_sin_drift_de_beacon_en_la_chain_real() public {
        vm.expectRevert(TokenRegistry.NoDrift.selector);
        reg.suspendOnBeaconDrift(AddressBook.TSLA);
    }

    function _expectedValue(address token, address feed) internal view returns (uint256 v, bool fresh) {
        (, int256 px,, uint256 upd,) = IAggregatorV3(feed).latestRoundData();
        v = IERC20(token).balanceOf(HOLDER) * uint256(px) / 1e8;
        if (v <= NAVLib.DUST_THRESHOLD_WAD) v = 0; // dust cuenta 0
        fresh = block.timestamp - upd <= STALENESS;
    }

    function test_nav_de_holder_real_cuadra_con_el_feed() public {
        address[] memory tokens = new address[](2);
        tokens[0] = AddressBook.TSLA;
        tokens[1] = AddressBook.NVDA;

        NAVLib.Snapshot memory s = nav.compute(reg, HOLDER, tokens);

        // Cálculo manual independiente con los mismos datos on-chain
        (uint256 vT, bool fT) = _expectedValue(AddressBook.TSLA, AddressBook.TSLA_FEED);
        (uint256 vN, bool fN) = _expectedValue(AddressBook.NVDA, AddressBook.NVDA_FEED);
        (, int256 pxU,, uint256 updU,) = IAggregatorV3(AddressBook.USDG_FEED).latestRoundData();
        uint256 balUWad = IERC20(AddressBook.USDG).balanceOf(HOLDER) * 1e12;

        assertEq(s.navWad, vT + vN + balUWad * uint256(pxU) / 1e8, "NAV = calculo manual");
        assertGt(s.navWad, 0, "el holder tiene valor");

        // La validez debe reflejar exactamente el staleness real del momento del fork
        // (dust: si la posicion conto 0, su feed no invalida)
        bool expectValid = (vT == 0 || fT) && (vN == 0 || fN)
            && (balUWad <= NAVLib.DUST_THRESHOLD_WAD || block.timestamp - updU <= STALENESS);
        assertEq(s.valid, expectValid, "validez coherente con el estado real de los feeds");

        console2.log("NAV del holder (WAD):", s.navWad);
        console2.log("valido ahora mismo:", s.valid);
    }
}
