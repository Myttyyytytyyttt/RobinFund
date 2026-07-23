// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20} from "../interfaces/IERC20.sol";
import {ITradeAdapter} from "../interfaces/ITradeAdapter.sol";
import {IAgentExecutionAdapter} from "../interfaces/IAgentExecutionAdapter.sol";
import {SafeTransferLib} from "../libraries/SafeTransferLib.sol";

/// @title UniswapApiAdapter
/// @notice Ejecuta una ruta CLASSIC exact-input obtenida de la Uniswap Trading API mediante el proxy
/// determinístico no-Permit2. El Fund continúa siendo la autoridad contable y mide todos los deltas.
contract UniswapApiAdapter is ITradeAdapter, IAgentExecutionAdapter {
    using SafeTransferLib for IERC20;

    bytes4 public constant PROXY_EXECUTE_SELECTOR =
        bytes4(keccak256("execute(address,address,uint256,bytes,bytes[],uint256)"));

    struct ExecutionPlan {
        uint256 minAmountOut;
        uint48 deadline;
        bytes callData;
    }

    address public immutable APPROVAL_PROXY;
    address public immutable UNIVERSAL_ROUTER;

    event ApiSwapExecuted(
        address indexed fund,
        address indexed tokenIn,
        address indexed tokenOut,
        uint256 amountIn,
        uint256 amountOut,
        bytes32 executionHash
    );

    error ZeroAddress();
    error NotFundCaller();
    error BadExecution();
    error QuoteExpired();
    error ProxyCallFailed(bytes reason);
    error ApprovalFailed();
    error MinimumOutputNotMet(uint256 received, uint256 minimum);
    error ResidualToken();

    constructor(address approvalProxy_, address universalRouter_) {
        if (
            approvalProxy_ == address(0) || approvalProxy_.code.length == 0 || universalRouter_ == address(0)
                || universalRouter_.code.length == 0
        ) revert ZeroAddress();
        APPROVAL_PROXY = approvalProxy_;
        UNIVERSAL_ROUTER = universalRouter_;
    }

    /// @dev `data = abi.encode(ExecutionPlan)`. La API debe recibir swapper=this y recipient=Fund.
    function swap(address tokenIn, address tokenOut, uint256 amountIn, address recipient, bytes calldata data)
        external
        override
    {
        if (msg.sender != recipient || recipient.code.length == 0) revert NotFundCaller();
        ExecutionPlan memory plan = abi.decode(data, (ExecutionPlan));
        if (amountIn == 0 || tokenIn == tokenOut || plan.minAmountOut == 0 || plan.callData.length < 4) {
            revert BadExecution();
        }
        if (block.timestamp > plan.deadline) revert QuoteExpired();
        if (!_matchesProxyCall(plan.callData, tokenIn, amountIn, plan.deadline)) revert BadExecution();
        if (IERC20(tokenIn).allowance(address(this), APPROVAL_PROXY) != 0) revert ResidualToken();

        // Un adapter compartido puede recibir dust permissionless. Se aparta el exceso ANTES de
        // medir el swap para que una donación de 1 wei no produzca un DoS ni pueda satisfacer minOut.
        uint256 inputBalance = IERC20(tokenIn).balanceOf(address(this));
        if (inputBalance < amountIn) revert ResidualToken();
        uint256 excessInput = inputBalance - amountIn;
        if (excessInput != 0) IERC20(tokenIn).safeTransfer(APPROVAL_PROXY, excessInput);
        uint256 outputDust = IERC20(tokenOut).balanceOf(address(this));
        if (outputDust != 0) IERC20(tokenOut).safeTransfer(APPROVAL_PROXY, outputDust);
        if (IERC20(tokenIn).balanceOf(address(this)) != amountIn) revert ResidualToken();

        uint256 outBefore = IERC20(tokenOut).balanceOf(recipient);
        _forceApprove(tokenIn, APPROVAL_PROXY, amountIn);
        (bool ok, bytes memory result) = APPROVAL_PROXY.call(plan.callData);
        _forceApprove(tokenIn, APPROVAL_PROXY, 0);
        if (!ok) revert ProxyCallFailed(result);

        uint256 outAfter = IERC20(tokenOut).balanceOf(recipient);
        if (outAfter < outBefore) revert BadExecution();
        uint256 received = outAfter - outBefore;
        if (received < plan.minAmountOut) revert MinimumOutputNotMet(received, plan.minAmountOut);
        if (
            IERC20(tokenIn).allowance(address(this), APPROVAL_PROXY) != 0
                || IERC20(tokenIn).balanceOf(address(this)) != 0 || IERC20(tokenOut).balanceOf(address(this)) != 0
        ) revert ResidualToken();

        emit ApiSwapExecuted(
            recipient, tokenIn, tokenOut, amountIn, received, keccak256(abi.encode(address(this), data))
        );
    }

    function validateExecution(
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        address recipient,
        uint256 minAmountOut,
        bytes calldata data
    ) external view override returns (bool) {
        if (recipient == address(0) || amountIn == 0 || tokenIn == tokenOut || data.length < 128) return false;
        ExecutionPlan memory plan = abi.decode(data, (ExecutionPlan));
        return plan.minAmountOut == minAmountOut && minAmountOut != 0 && plan.deadline >= block.timestamp
            && _matchesProxyCall(plan.callData, tokenIn, amountIn, plan.deadline);
    }

    /// @dev The execution hash binds every byte, while this check additionally restricts the
    /// approved target to the one exact-input entry point and binds its visible spend fields.
    /// The proxy ABI exposes router, input token and amount, but not output token/recipient. Those
    /// remain enforced by the quote binding plus the Fund balance delta and minOut post-condition.
    /// The proxy may use a longer router deadline; the signed plan deadline still gates this adapter.
    function _matchesProxyCall(bytes memory callData, address tokenIn, uint256 amountIn, uint48 deadline)
        private
        view
        returns (bool)
    {
        if (callData.length < 4) return false;
        bytes4 selector;
        assembly ("memory-safe") {
            selector := mload(add(callData, 0x20))
        }
        if (selector != PROXY_EXECUTE_SELECTOR) return false;

        uint256 payloadLength = callData.length - 4;
        bytes memory payload = new bytes(payloadLength);
        assembly ("memory-safe") {
            let source := add(callData, 0x24)
            let destination := add(payload, 0x20)
            for { let offset := 0 } lt(offset, payloadLength) { offset := add(offset, 0x20) } {
                mstore(add(destination, offset), mload(add(source, offset)))
            }
        }
        (
            address proxyRouter,
            address proxyTokenIn,
            uint256 proxyAmountIn,,,
            uint256 proxyDeadline
        ) = abi.decode(payload, (address, address, uint256, bytes, bytes[], uint256));
        return proxyRouter == UNIVERSAL_ROUTER && proxyTokenIn == tokenIn && proxyAmountIn == amountIn
            && proxyDeadline >= deadline;
    }

    function _forceApprove(address token, address spender, uint256 amount) private {
        (bool ok, bytes memory result) = token.call(abi.encodeCall(IERC20.approve, (spender, amount)));
        if (!ok || (result.length != 0 && !abi.decode(result, (bool)))) revert ApprovalFailed();
    }
}
