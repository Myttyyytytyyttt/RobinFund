// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @notice Adapter de trading (SPEC §8). El Fund transfiere `amountIn` de `tokenIn` al adapter y lo
/// llama; el adapter ejecuta el swap en su venue y DEVUELVE el `tokenOut` al Fund. El Fund NO confía
/// en el adapter para la contabilidad: mide sus propios deltas de balance y aplica el guardarraíl de
/// slippage contra Chainlink (revisión: la seguridad vive en el Fund, no en el adapter whitelisteado).
interface ITradeAdapter {
    /// @param tokenIn activo entregado (ya transferido al adapter por el Fund)
    /// @param tokenOut activo a devolver al Fund
    /// @param amountIn cantidad de tokenIn transferida
    /// @param recipient el Fund (a donde devolver el tokenOut)
    /// @param data payload específico del venue (poolKey, fee tier, etc.)
    function swap(address tokenIn, address tokenOut, uint256 amountIn, address recipient, bytes calldata data)
        external;
}
