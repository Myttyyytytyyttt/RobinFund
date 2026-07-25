import { encodeAbiParameters, encodeFunctionData, keccak256, parseAbi, type Address, type Hex } from "viem";
import { describe, expect, it } from "vitest";
import { verifyExecutionPlanLocally } from "../src/client.js";
import { tradeIntentTypes, type QuoteInput, type QuoteResult } from "../src/types.js";

const fund = "0x1111111111111111111111111111111111111111" as const;
const controller = "0x2222222222222222222222222222222222222222" as const;
const adapter = "0x3333333333333333333333333333333333333333" as const;
const proxy = "0x0000000085e102724e78ecd2f45dc9ca239affad" as const;
const router = "0x8876789976decbfcbbbe364623c63652db8c0904" as const;
const tokenIn = "0x4444444444444444444444444444444444444444" as const;
const tokenOut = "0x5555555555555555555555555555555555555555" as const;
const evidenceHash = `0x${"66".repeat(32)}` as Hex;
const approvalProxyAbi = parseAbi([
  "function execute(address router,address token,uint256 amount,bytes commands,bytes[] inputs,uint256 deadline)",
]);

function fixture(options: { router?: Address; proxyDeadlineOffset?: number } = {}): { quote: QuoteResult; input: QuoteInput } {
  const deadline = Math.floor(Date.now() / 1_000) + 30;
  const routeCalldata = encodeFunctionData({
    abi: approvalProxyAbi,
    functionName: "execute",
    args: [options.router ?? router, tokenIn, 1_000n, "0x1234", ["0xabcd"], BigInt(deadline + (options.proxyDeadlineOffset ?? 0))],
  });
  const adapterData = encodeAbiParameters(
    [{ type: "tuple", components: [
      { name: "minAmountOut", type: "uint256" },
      { name: "deadline", type: "uint48" },
      { name: "callData", type: "bytes" },
    ] }],
    [{ minAmountOut: 980n, deadline, callData: routeCalldata }],
  );
  const executionHash = keccak256(encodeAbiParameters(
    [{ type: "uint256" }, { type: "bytes" }], [7n, adapterData],
  ));
  const input: QuoteInput = {
    tokenIn, tokenOut, amountIn: 1_000n, maxSlippageBps: 75,
    evidenceHash, reasoningHash: `0x${"77".repeat(32)}`, summary: "test",
  };
  const intent = {
    agentId: `0x${"88".repeat(32)}` as Hex,
    fund, tokenIn, tokenOut, amountIn: 1_000n, minAmountOut: 980n, maxSlippageBps: 75,
    policyHash: `0x${"99".repeat(32)}` as Hex, executionHash, evidenceHash,
    nonce: 0n, validAfter: deadline - 30, deadline,
  };
  return {
    input,
    quote: {
      executionPlan: {
        proposalId: "p", quoteId: "q", quoteHash: `0x${"aa".repeat(32)}`,
        adapter, approvalProxy: proxy, adapterId: 7n, fund, controller, chainId: 4663,
        tokenIn, tokenOut, amountIn: 1_000n, quotedAmountOut: 990n, minAmountOut: 980n,
        routeCalldata, adapterData, executionHash, expiresAt: new Date(deadline * 1_000),
      },
      intent,
      typedData: {
        domain: { name: "Nuvem AgentVaultController", version: "1", chainId: 4663, verifyingContract: controller },
        types: tradeIntentTypes, primaryType: "TradeIntentV1", message: intent,
      },
      provenance: {
        deploymentId: "d",
        chainId: 4663,
        blockNumber: 1n,
        blockHash: null,
        blockTimestamp: new Date(),
        chainHeadBlock: 1n,
        blockLag: 0n,
        indexingErrors: false,
        observedAt: new Date(),
        ageSeconds: 0,
      },
    },
  };
}

const safety = {
  chainId: 4663,
  expectedFund: fund,
  expectedController: controller,
  expectedAdapter: adapter,
  expectedApprovalProxy: proxy,
  expectedUniversalRouter: router,
  maxSlippageBps: 75,
};

describe("local execution-plan safety", () => {
  it("accepts an exactly bound plan", () => {
    const { quote, input } = fixture();
    expect(() => verifyExecutionPlanLocally(quote, input, safety)).not.toThrow();
  });

  it("accepts an outer router deadline longer than the signed plan", () => {
    const { quote, input } = fixture({ proxyDeadlineOffset: 1_500 });
    expect(() => verifyExecutionPlanLocally(quote, input, safety)).not.toThrow();
  });

  it("rejects an unexpected Universal Router", () => {
    const { quote, input } = fixture({ router: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" });
    expect(() => verifyExecutionPlanLocally(quote, input, safety)).toThrowError(/router/);
  });

  it("rejects a changed recipient", () => {
    const { quote, input } = fixture();
    quote.executionPlan.fund = "0xffffffffffffffffffffffffffffffffffffffff";
    expect(() => verifyExecutionPlanLocally(quote, input, safety)).toThrowError(/recipient/);
  });

  it("rejects altered adapter calldata", () => {
    const { quote, input } = fixture();
    quote.executionPlan.routeCalldata = "0xdeadbeef";
    expect(() => verifyExecutionPlanLocally(quote, input, safety)).toThrowError(/payload/);
  });

  it("rejects a proxy selector not supported by the adapter", () => {
    const { quote, input } = fixture();
    const routeCalldata = "0x12345678" as Hex;
    quote.executionPlan.routeCalldata = routeCalldata;
    const [decoded] = [quote.executionPlan];
    decoded.adapterData = encodeAbiParameters(
      [{ type: "tuple", components: [
        { name: "minAmountOut", type: "uint256" },
        { name: "deadline", type: "uint48" },
        { name: "callData", type: "bytes" },
      ] }],
      [{ minAmountOut: decoded.minAmountOut, deadline: quote.intent.deadline, callData: routeCalldata }],
    );
    decoded.executionHash = keccak256(encodeAbiParameters(
      [{ type: "uint256" }, { type: "bytes" }], [decoded.adapterId, decoded.adapterData],
    ));
    quote.intent.executionHash = decoded.executionHash;
    expect(() => verifyExecutionPlanLocally(quote, input, safety)).toThrowError(/selector/);
  });

  it("rejects altered spend fields hidden inside proxy calldata", () => {
    const { quote, input } = fixture();
    const routeCalldata = encodeFunctionData({
      abi: approvalProxyAbi,
      functionName: "execute",
      args: [router, tokenIn, 999n, "0x1234", ["0xabcd"], BigInt(quote.intent.deadline)],
    });
    quote.executionPlan.routeCalldata = routeCalldata;
    quote.executionPlan.adapterData = encodeAbiParameters(
      [{ type: "tuple", components: [
        { name: "minAmountOut", type: "uint256" },
        { name: "deadline", type: "uint48" },
        { name: "callData", type: "bytes" },
      ] }],
      [{ minAmountOut: quote.executionPlan.minAmountOut, deadline: quote.intent.deadline, callData: routeCalldata }],
    );
    quote.executionPlan.executionHash = keccak256(encodeAbiParameters(
      [{ type: "uint256" }, { type: "bytes" }],
      [quote.executionPlan.adapterId, quote.executionPlan.adapterData],
    ));
    quote.intent.executionHash = quote.executionPlan.executionHash;
    expect(() => verifyExecutionPlanLocally(quote, input, safety)).toThrowError(/fields/);
  });

  it("rejects a different proxy", () => {
    const { quote, input } = fixture();
    quote.executionPlan.approvalProxy = "0xffffffffffffffffffffffffffffffffffffffff";
    expect(() => verifyExecutionPlanLocally(quote, input, safety)).toThrowError(/proxy/);
  });

  it("rejects slippage above local policy", () => {
    const { quote, input } = fixture();
    quote.intent.maxSlippageBps = 100;
    expect(() => verifyExecutionPlanLocally(quote, input, safety)).toThrowError(/slippage/);
  });
});
