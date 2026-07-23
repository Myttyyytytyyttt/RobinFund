// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20} from "../interfaces/IERC20.sol";
import {SafeTransferLib} from "../libraries/SafeTransferLib.sol";

/// @notice Local-only stand-in for Uniswap's deterministic approval proxy.
/// @dev It deliberately exposes the production proxy selector so the complete
/// AgentVaultController -> Fund -> UniswapApiAdapter path can be tested without
/// an API key. It must never be used outside chain id 31337.
contract DevnetApprovalProxy {
    using SafeTransferLib for IERC20;

    event DevnetSwap(address indexed caller, address indexed recipient, address tokenIn, address tokenOut, uint256 amountIn, uint256 amountOut);

    error Expired();
    error BadRoute();

    function execute(
        address router,
        address tokenIn,
        uint256 amountIn,
        bytes calldata route,
        bytes[] calldata,
        uint256 deadline
    ) external {
        if (block.timestamp > deadline) revert Expired();
        (address tokenOut, address recipient, uint256 amountOut) = abi.decode(route, (address, address, uint256));
        if (
            router != address(this) || recipient == address(0) || amountIn == 0 || amountOut == 0
                || tokenIn == tokenOut
        ) revert BadRoute();
        IERC20(tokenIn).safeTransferFrom(msg.sender, address(this), amountIn);
        IERC20(tokenOut).safeTransfer(recipient, amountOut);
        emit DevnetSwap(msg.sender, recipient, tokenIn, tokenOut, amountIn, amountOut);
    }
}
