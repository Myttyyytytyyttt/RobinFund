// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {UniswapApiAdapter} from "../../../src/adapters/UniswapApiAdapter.sol";
import {IERC20} from "../../../src/interfaces/IERC20.sol";
import {MockUSDG} from "../../mocks/Mocks.sol";

interface IMintableToken {
    function mint(address to, uint256 amount) external;
}

contract ApprovalProxyMock {
    address public sink = address(0x51A9);
    bool public failNext;

    function setFail(bool value) external {
        failNext = value;
    }

    function execute(
        address router,
        address tokenIn,
        uint256 amountIn,
        bytes calldata route,
        bytes[] calldata,
        uint256 deadline
    ) external {
        require(!failNext, "quote failed");
        require(block.timestamp <= deadline, "expired");
        require(router == address(this), "wrong router");
        (address tokenOut, address recipient, uint256 amountOut) = abi.decode(route, (address, address, uint256));
        IERC20(tokenIn).transferFrom(msg.sender, sink, amountIn);
        IMintableToken(tokenOut).mint(recipient, amountOut);
    }
}

contract FundCallerMock {
    function execute(
        UniswapApiAdapter adapter,
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        bytes calldata data
    ) external {
        IERC20(tokenIn).transfer(address(adapter), amountIn);
        adapter.swap(tokenIn, tokenOut, amountIn, address(this), data);
    }
}

contract UniswapApiAdapterTest is Test {
    MockUSDG internal tokenIn;
    MockUSDG internal tokenOut;
    ApprovalProxyMock internal proxy;
    UniswapApiAdapter internal adapter;
    FundCallerMock internal fund;

    function setUp() public {
        vm.warp(1_800_000_000);
        tokenIn = new MockUSDG();
        tokenOut = new MockUSDG();
        proxy = new ApprovalProxyMock();
        adapter = new UniswapApiAdapter(address(proxy), address(proxy));
        fund = new FundCallerMock();
        tokenIn.mint(address(fund), 1_000_000000);
    }

    function test_ruta_exact_input_sin_allowance_ni_residuos() public {
        bytes memory data = _plan(1_000_000000, 995_000000, address(fund));
        fund.execute(adapter, address(tokenIn), address(tokenOut), 1_000_000000, data);

        assertEq(tokenOut.balanceOf(address(fund)), 995_000000);
        assertEq(tokenIn.balanceOf(address(adapter)), 0);
        assertEq(tokenOut.balanceOf(address(adapter)), 0);
        assertEq(tokenIn.allowance(address(adapter), address(proxy)), 0);
    }

    function test_dust_donado_no_bloquea_ni_cuenta_como_output() public {
        tokenIn.mint(address(adapter), 1);
        tokenOut.mint(address(adapter), 2);
        bytes memory data = _plan(1_000_000000, 995_000000, address(fund));
        fund.execute(adapter, address(tokenIn), address(tokenOut), 1_000_000000, data);

        assertEq(tokenOut.balanceOf(address(fund)), 995_000000);
        assertEq(tokenIn.balanceOf(address(adapter)), 0);
        assertEq(tokenOut.balanceOf(address(adapter)), 0);
        assertEq(tokenIn.allowance(address(adapter), address(proxy)), 0);
    }

    function test_minOut_y_recipient_incorrecto_revierten_atomicamente() public {
        bytes memory lowOutput = abi.encode(
            UniswapApiAdapter.ExecutionPlan({
                minAmountOut: 999_000000,
                deadline: uint48(block.timestamp + 5 minutes),
                callData: abi.encodeCall(
                    proxy.execute,
                    (
                        address(proxy),
                        address(tokenIn),
                        1_000_000000,
                        abi.encode(address(tokenOut), address(fund), 995_000000),
                        new bytes[](0),
                        block.timestamp + 5 minutes
                    )
                )
            })
        );
        vm.expectPartialRevert(UniswapApiAdapter.MinimumOutputNotMet.selector);
        fund.execute(adapter, address(tokenIn), address(tokenOut), 1_000_000000, lowOutput);
        assertEq(tokenIn.balanceOf(address(fund)), 1_000_000000);

        bytes memory wrongRecipient = _plan(1_000_000000, 995_000000, address(0xBAD));
        vm.expectPartialRevert(UniswapApiAdapter.MinimumOutputNotMet.selector);
        fund.execute(adapter, address(tokenIn), address(tokenOut), 1_000_000000, wrongRecipient);
        assertEq(tokenIn.balanceOf(address(fund)), 1_000_000000);
    }

    function test_quote_expirado_y_proxy_revertido_no_dejan_approval() public {
        bytes memory expired = _planAt(1_000_000000, 1, address(fund), uint48(block.timestamp - 1));
        vm.expectRevert(UniswapApiAdapter.QuoteExpired.selector);
        fund.execute(adapter, address(tokenIn), address(tokenOut), 1_000_000000, expired);

        proxy.setFail(true);
        bytes memory failing = _plan(1_000_000000, 1, address(fund));
        vm.expectPartialRevert(UniswapApiAdapter.ProxyCallFailed.selector);
        fund.execute(adapter, address(tokenIn), address(tokenOut), 1_000_000000, failing);
        assertEq(tokenIn.allowance(address(adapter), address(proxy)), 0);
        assertEq(tokenIn.balanceOf(address(fund)), 1_000_000000);
    }

    function test_selector_y_campos_externos_adulterados_revierten() public {
        bytes memory arbitrary = abi.encode(
            UniswapApiAdapter.ExecutionPlan({
                minAmountOut: 1,
                deadline: uint48(block.timestamp + 5 minutes),
                callData: abi.encodeCall(proxy.setFail, (false))
            })
        );
        vm.expectRevert(UniswapApiAdapter.BadExecution.selector);
        fund.execute(adapter, address(tokenIn), address(tokenOut), 1_000_000000, arbitrary);

        uint48 deadline = uint48(block.timestamp + 5 minutes);
        bytes memory wrongAmount = abi.encode(
            UniswapApiAdapter.ExecutionPlan({
                minAmountOut: 1,
                deadline: deadline,
                callData: abi.encodeCall(
                    proxy.execute,
                    (
                        address(proxy),
                        address(tokenIn),
                        999_000000,
                        abi.encode(address(tokenOut), address(fund), 1),
                        new bytes[](0),
                        uint256(deadline)
                    )
                )
            })
        );
        vm.expectRevert(UniswapApiAdapter.BadExecution.selector);
        fund.execute(adapter, address(tokenIn), address(tokenOut), 1_000_000000, wrongAmount);
    }

    function test_router_token_input_y_deadline_externo_quedan_ligados() public {
        uint48 planDeadline = uint48(block.timestamp + 5 minutes);

        bytes memory wrongRouter = _planBound(
            1_000_000000, 1, address(fund), planDeadline, uint256(planDeadline), address(0xBAD), address(tokenIn)
        );
        vm.expectRevert(UniswapApiAdapter.BadExecution.selector);
        fund.execute(adapter, address(tokenIn), address(tokenOut), 1_000_000000, wrongRouter);

        bytes memory wrongInput = _planBound(
            1_000_000000, 1, address(fund), planDeadline, uint256(planDeadline), address(proxy), address(tokenOut)
        );
        vm.expectRevert(UniswapApiAdapter.BadExecution.selector);
        fund.execute(adapter, address(tokenIn), address(tokenOut), 1_000_000000, wrongInput);

        bytes memory tooShort = _planBound(
            1_000_000000,
            1,
            address(fund),
            planDeadline,
            uint256(planDeadline - 1),
            address(proxy),
            address(tokenIn)
        );
        vm.expectRevert(UniswapApiAdapter.BadExecution.selector);
        fund.execute(adapter, address(tokenIn), address(tokenOut), 1_000_000000, tooShort);

        bytes memory longerProxyDeadline = _planBound(
            1_000_000000,
            995_000000,
            address(fund),
            planDeadline,
            uint256(planDeadline + 25 minutes),
            address(proxy),
            address(tokenIn)
        );
        fund.execute(adapter, address(tokenIn), address(tokenOut), 1_000_000000, longerProxyDeadline);
        assertEq(tokenOut.balanceOf(address(fund)), 995_000000);
    }

    function _plan(uint256 amountIn, uint256 amountOut, address recipient) internal view returns (bytes memory) {
        return _planAt(amountIn, amountOut, recipient, uint48(block.timestamp + 5 minutes));
    }

    function _planAt(uint256 amountIn, uint256 amountOut, address recipient, uint48 deadline)
        internal
        view
        returns (bytes memory)
    {
        return _planBound(
            amountIn, amountOut, recipient, deadline, uint256(deadline), address(proxy), address(tokenIn)
        );
    }

    function _planBound(
        uint256 amountIn,
        uint256 amountOut,
        address recipient,
        uint48 deadline,
        uint256 proxyDeadline,
        address router,
        address proxyTokenIn
    ) internal view returns (bytes memory) {
        return abi.encode(
            UniswapApiAdapter.ExecutionPlan({
                minAmountOut: amountOut,
                deadline: deadline,
                callData: abi.encodeCall(
                    proxy.execute,
                    (
                        router,
                        proxyTokenIn,
                        amountIn,
                        abi.encode(address(tokenOut), recipient, amountOut),
                        new bytes[](0),
                        proxyDeadline
                    )
                )
            })
        );
    }
}
