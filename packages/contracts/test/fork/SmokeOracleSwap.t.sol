// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test, console2} from "forge-std/Test.sol";
import {AddressBook} from "../../src/AddressBook.sol";
import {IERC20} from "../../src/interfaces/IERC20.sol";

interface IAggregatorV3 {
    function decimals() external view returns (uint8);
    function latestRoundData()
        external
        view
        returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound);
}

struct PoolKey {
    address currency0;
    address currency1;
    uint24 fee;
    int24 tickSpacing;
    address hooks;
}

interface IV4Quoter {
    struct QuoteExactSingleParams {
        PoolKey poolKey;
        bool zeroForOne;
        uint128 exactAmount;
        bytes hookData;
    }

    function quoteExactInputSingle(QuoteExactSingleParams calldata p)
        external
        returns (uint256 amountOut, uint256 gasEstimate);
}

interface IPoolManager {
    struct SwapParams {
        bool zeroForOne;
        int256 amountSpecified; // negativo = exact input
        uint160 sqrtPriceLimitX96;
    }

    function unlock(bytes calldata data) external returns (bytes memory);
    function swap(PoolKey calldata key, SwapParams calldata params, bytes calldata hookData)
        external
        returns (int256 delta);
    function sync(address currency) external;
    function settle() external payable returns (uint256);
    function take(address currency, address to, uint256 amount) external;
}

/// @notice Embrión del UniswapV4Adapter de Fase 1: swap exact-in directo contra el PoolManager
/// (unlock → swap → sync/transfer/settle → take), sin router intermedio.
contract V4SwapProbe {
    uint160 constant MIN_SQRT_PRICE_PLUS_1 = 4295128740;
    IPoolManager immutable pm;

    constructor(IPoolManager _pm) {
        pm = _pm;
    }

    function swapExactIn(PoolKey calldata key, bool zeroForOne, uint128 amountIn, address recipient)
        external
        returns (uint256 out)
    {
        bytes memory result = pm.unlock(abi.encode(key, zeroForOne, amountIn, recipient));
        out = abi.decode(result, (uint256));
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        require(msg.sender == address(pm), "solo PoolManager");
        (PoolKey memory key, bool zeroForOne, uint128 amountIn, address recipient) =
            abi.decode(data, (PoolKey, bool, uint128, address));

        int256 delta = pm.swap(
            key,
            IPoolManager.SwapParams({
                zeroForOne: zeroForOne,
                amountSpecified: -int256(uint256(amountIn)),
                sqrtPriceLimitX96: MIN_SQRT_PRICE_PLUS_1
            }),
            ""
        );
        // BalanceDelta: amount0 en los 128 bits altos, amount1 en los bajos (con signo)
        int128 amount1 = int128(int256(delta));
        uint256 out = uint256(uint128(amount1)); // zeroForOne: amount1 > 0 = lo que nos deben

        // Pagamos el input: sync → transfer al PM → settle
        address currencyIn = zeroForOne ? key.currency0 : key.currency1;
        pm.sync(currencyIn);
        IERC20(currencyIn).transfer(address(pm), amountIn);
        pm.settle();

        // Cobramos el output
        address currencyOut = zeroForOne ? key.currency1 : key.currency0;
        pm.take(currencyOut, recipient, out);

        return abi.encode(out);
    }
}

/// @notice Fase 0.4: oráculos reales + swap real TSLA→USDG contra el Uniswap dedicado de la chain.
contract ForkOracleSwapTest is Test {
    address constant DONOR = 0x000000000000000000000000000000000000dEaD;

    function setUp() public {
        vm.createSelectFork(vm.envString("RH_RPC_MAINNET"));
    }

    function test_feeds_chainlink_reales() public view {
        IAggregatorV3 tslaFeed = IAggregatorV3(AddressBook.TSLA_FEED);
        IAggregatorV3 usdgFeed = IAggregatorV3(AddressBook.USDG_FEED);

        assertEq(tslaFeed.decimals(), 8, "feed 8 dec");
        (, int256 px,, uint256 upd,) = tslaFeed.latestRoundData();
        assertGt(px, 0, "precio TSLA > 0");
        // Feeds 24/5 con heartbeat 24h: en fin de semana la antiguedad puede superar el heartbeat.
        assertLt(block.timestamp - upd, 4 days, "feed no abandonado");
        console2.log("TSLA/USD (8 dec):", uint256(px));
        console2.log("antiguedad del feed (s):", block.timestamp - upd);

        (, int256 pUsdg,, uint256 updU,) = usdgFeed.latestRoundData();
        assertGt(pUsdg, 0, "USDG/USD > 0");
        console2.log("USDG/USD (8 dec):", uint256(pUsdg));
        console2.log("antiguedad USDG feed (s):", block.timestamp - updU);
    }

    // La liquidez real de la chain vive en Uniswap V4 (el pool v3 TSLA/USDG existe pero esta vacio).
    // PoolKey descubierta con el V4Quoter en Fase 0.4: (TSLA, USDG, fee 3000, tickSpacing 60, sin hooks).
    function _tslaUsdgKey() internal pure returns (PoolKey memory) {
        return PoolKey({
            currency0: AddressBook.TSLA, // TSLA < USDG por orden de address
            currency1: AddressBook.USDG,
            fee: 3000,
            tickSpacing: 60,
            hooks: address(0)
        });
    }

    function test_quote_v4_tsla_usdg() public {
        (uint256 out, uint256 gasEst) = IV4Quoter(AddressBook.UNI_V4_QUOTER).quoteExactInputSingle(
            IV4Quoter.QuoteExactSingleParams({
                poolKey: _tslaUsdgKey(),
                zeroForOne: true, // TSLA -> USDG
                exactAmount: 1e18,
                hookData: ""
            })
        );
        assertGt(out, 0, "quote > 0");
        console2.log("quote v4: 1 TSLA -> USDG (6 dec):", out);
        console2.log("gas estimado:", gasEst);
    }

    function test_swap_real_tsla_a_usdg_por_uniswap_v4() public {
        IERC20 tsla = IERC20(AddressBook.TSLA);
        IERC20 usdg = IERC20(AddressBook.USDG);
        uint128 amountIn = uint128(tsla.balanceOf(DONOR) / 2);
        assertGt(amountIn, 0, "donante con TSLA");

        // Nuestro propio contrato ejecuta el swap contra el PoolManager — el camino del adapter de Fase 1.
        V4SwapProbe probe = new V4SwapProbe(IPoolManager(AddressBook.UNI_V4_POOL_MANAGER));
        vm.prank(DONOR);
        tsla.transfer(address(probe), amountIn);

        uint256 out = probe.swapExactIn(_tslaUsdgKey(), true, amountIn, address(this));

        assertGt(out, 0, "recibimos USDG del swap v4");
        assertEq(usdg.balanceOf(address(this)), out, "USDG acreditado al recipient");
        console2.log("swap v4 directo ejecutado: TSLA in (18 dec):", amountIn);
        console2.log("USDG out (6 dec):", out);
    }
}
