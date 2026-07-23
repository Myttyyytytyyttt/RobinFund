// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @notice Superficie de validacion consumida por AgentVaultController antes
/// de transferir activos del Fund a un adapter.
interface IAgentExecutionAdapter {
    function validateExecution(
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        address recipient,
        uint256 minAmountOut,
        bytes calldata data
    ) external view returns (bool);
}
