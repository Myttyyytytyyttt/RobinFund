// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20} from "../interfaces/IERC20.sol";
import {ITradeAdapter} from "../interfaces/ITradeAdapter.sol";
import {SafeTransferLib} from "../libraries/SafeTransferLib.sol";

struct PoolKey {
    address currency0;
    address currency1;
    uint24 fee;
    int24 tickSpacing;
    address hooks;
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

/// @title UniswapV4Adapter — swap exact-in contra el PoolManager v4 de Robinhood Chain (SPEC §8)
/// @notice Patrón verificado en Fase 0 (`V4SwapProbe`): unlock → swap → sync/transfer/settle → take.
/// El Fund le transfiere `amountIn` de `tokenIn` antes de llamar; el adapter swapea y envía `tokenOut`
/// al `recipient` (el Fund). No custodia fondos entre llamadas. `data` = abi.encode(PoolKey).
/// La seguridad económica (slippage, deltas) la aplica el Fund midiendo sus propios balances.
contract UniswapV4Adapter is ITradeAdapter {
    using SafeTransferLib for IERC20;

    uint160 internal constant MIN_SQRT_PRICE_PLUS_1 = 4295128740;
    uint160 internal constant MAX_SQRT_PRICE_MINUS_1 = 1461446703485210103287273052203988822378723970342 - 1;

    IPoolManager public immutable POOL_MANAGER;

    error NotPoolManager();
    error WrongTokens();

    constructor(IPoolManager pm) {
        POOL_MANAGER = pm;
    }

    function swap(address tokenIn, address tokenOut, uint256 amountIn, address recipient, bytes calldata data)
        external
        override
    {
        PoolKey memory key = abi.decode(data, (PoolKey));
        bool zeroForOne;
        if (tokenIn == key.currency0 && tokenOut == key.currency1) {
            zeroForOne = true;
        } else if (tokenIn == key.currency1 && tokenOut == key.currency0) {
            zeroForOne = false;
        } else {
            revert WrongTokens();
        }
        POOL_MANAGER.unlock(abi.encode(key, zeroForOne, amountIn, recipient, tokenIn, tokenOut));
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != address(POOL_MANAGER)) revert NotPoolManager();
        (PoolKey memory key, bool zeroForOne, uint256 amountIn, address recipient, address tokenIn, address tokenOut) =
            abi.decode(data, (PoolKey, bool, uint256, address, address, address));

        int256 delta = POOL_MANAGER.swap(
            key,
            IPoolManager.SwapParams({
                zeroForOne: zeroForOne,
                amountSpecified: -int256(amountIn),
                sqrtPriceLimitX96: zeroForOne ? MIN_SQRT_PRICE_PLUS_1 : MAX_SQRT_PRICE_MINUS_1
            }),
            ""
        );
        // BalanceDelta: amount0 en los 128 bits altos, amount1 en los bajos (con signo)
        int128 amount0 = int128(delta >> 128);
        int128 amount1 = int128(delta);
        uint256 out = zeroForOne ? uint256(uint128(amount1)) : uint256(uint128(amount0));

        // pagar el input al PM
        POOL_MANAGER.sync(tokenIn);
        IERC20(tokenIn).safeTransfer(address(POOL_MANAGER), amountIn);
        POOL_MANAGER.settle();

        // cobrar el output directamente al recipient (el Fund)
        POOL_MANAGER.take(tokenOut, recipient, out);
        return abi.encode(out);
    }
}
